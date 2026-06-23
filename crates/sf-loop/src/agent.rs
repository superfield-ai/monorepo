//! Agent executor abstraction — LLM call seam for the gardening loop.
//!
//! [`AgentExecutor`] is the trait through which the gardening steps
//! interact with the language model.  Two implementations are provided:
//!
//! - [`LlmAgentExecutor`] — real implementation that calls the LLM API via
//!   HTTP.  Reads `SF_LLM_API_KEY`, `SF_LLM_ENDPOINT`, and `SF_LLM_MODEL`
//!   from the [`crate::LoopConfig`].  When `SF_OTEL_DISABLED=1` (or the key
//!   is empty), all outbound HTTP calls are skipped and a canned response is
//!   returned (satisfies the `sf_otel_disabled_prevents_external_calls` test).
//!
//! - [`FixtureAgentExecutor`] — deterministic stub for unit/integration tests.
//!   Returns a fixed `AgentResponse` for every call and records how many
//!   times it was invoked (supports the call-counter assertions in the test
//!   plan).

use crate::provider::LlmProvider;
use std::future::Future;
use std::pin::Pin;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use thiserror::Error;

/// Boxed async future alias.
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A single request to the agent executor.
#[derive(Debug, Clone)]
pub struct AgentRequest {
    /// The system prompt / instructions for the step.
    pub system: String,
    /// The user-facing prompt (context, pages, etc.).
    pub user: String,
}

/// The executor's response.
#[derive(Debug, Clone)]
pub struct AgentResponse {
    /// The generated content to be stored as a page revision.
    pub content: String,
    /// Provenance metadata (agent step name, source URLs, etc.).
    pub provenance: String,
    /// Estimated US-dollar cost of the call, as reported by the executor.
    ///
    /// This is the cost-accounting source the orchestrator's work-slot cards
    /// surface (issue #712). The real [`LlmAgentExecutor`] derives it from the
    /// model's reported input/output token usage; the
    /// [`FixtureAgentExecutor`] returns a small fixed cost so tests observe a
    /// non-zero, populated `costUsd` field on the published `WorkSlot`.
    pub cost_usd: f64,
}

/// Errors from the agent executor.
#[derive(Debug, Error)]
pub enum AgentError {
    /// HTTP or network error.
    #[error("http error: {0}")]
    Http(String),
    /// Unexpected API response structure.
    #[error("parse error: {0}")]
    Parse(String),
}

/// Seam interface for running a single LLM prompt.
///
/// The gardening steps call [`AgentExecutor::run`] to produce their page
/// revision content.  Tests inject a [`FixtureAgentExecutor`]; the daemon
/// injects a [`LlmAgentExecutor`].
pub trait AgentExecutor: Send + Sync {
    /// Execute a single agent request and return the response.
    fn run<'a>(&'a self, req: AgentRequest) -> BoxFuture<'a, Result<AgentResponse, AgentError>>;
}

/// Indicative input-token price in US dollars per million tokens.
const INPUT_USD_PER_MTOK: f64 = 1.0;
/// Indicative output-token price in US dollars per million tokens.
const OUTPUT_USD_PER_MTOK: f64 = 5.0;

/// Estimate the US-dollar cost of a call from its input/output token counts.
///
/// Used by [`LlmAgentExecutor`] to populate [`AgentResponse::cost_usd`] from the
/// model's reported usage so the orchestrator work-slot cards show real,
/// accumulating cost (issue #712).
fn cost_from_usage(input_tokens: f64, output_tokens: f64) -> f64 {
    (input_tokens * INPUT_USD_PER_MTOK + output_tokens * OUTPUT_USD_PER_MTOK) / 1_000_000.0
}

// ---------------------------------------------------------------------------
// LlmAgentExecutor — real implementation
// ---------------------------------------------------------------------------

/// Real LLM executor that calls the configured API endpoint.
///
/// Controlled by:
/// - `SF_LLM_PROVIDER` — `anthropic` (default) or `openai-compatible` wire shape.
/// - `SF_LLM_API_KEY`   — authentication header value.
/// - `SF_LLM_ENDPOINT`  — URL to POST to.
/// - `SF_LLM_MODEL`     — model name.
/// - `SF_OTEL_DISABLED` — when `"1"`, all HTTP is skipped.
///
/// The wire shaping (headers, request body, response parsing) is delegated to
/// [`LlmProvider`], so the Anthropic and OpenAI-compatible paths share one HTTP
/// flow and differ only in pure, unit-tested shaping (issue #748).
pub struct LlmAgentExecutor {
    provider: LlmProvider,
    api_key: String,
    endpoint: String,
    model: String,
    client: reqwest::Client,
}

impl LlmAgentExecutor {
    /// Create from the given config fields, defaulting to the Anthropic wire.
    pub fn new(api_key: String, endpoint: String, model: String) -> Self {
        Self::with_provider(LlmProvider::Anthropic, api_key, endpoint, model)
    }

    /// Create with an explicit [`LlmProvider`] wire shape.
    pub fn with_provider(
        provider: LlmProvider,
        api_key: String,
        endpoint: String,
        model: String,
    ) -> Self {
        Self {
            provider,
            api_key,
            endpoint,
            model,
            client: reqwest::Client::new(),
        }
    }

    /// Drive one prompt through a **keyless** `opencode serve` instance.
    ///
    /// Talks to the local server's session API: `POST /session` to open a
    /// session, then `POST /session/{id}/message` with the model + a single text
    /// part (built by [`LlmProvider::opencode_message_body`]). The assistant text
    /// comes back in `parts[].text` and is extracted by
    /// [`LlmProvider::parse_opencode_message`]; token usage by
    /// [`LlmProvider::parse_opencode_usage`].
    ///
    /// A fresh `opencode` install reaches OpenCode's free Big Pickle model with
    /// **no API key and no login**, so this is the path CI uses to exercise the
    /// loop against a live model without any repo secret (issue #748). The server
    /// base URL is [`Self::endpoint`] (from `SF_OPENCODE_SERVER`, default
    /// [`LlmProvider::DEFAULT_OPENCODE_SERVER`]); the workflow boots
    /// `opencode serve` on it before the appliance starts.
    ///
    /// Unlike the headless `opencode run` CLI — which does not print the
    /// assistant text to stdout in non-interactive mode — the server API returns
    /// the completed message synchronously, which is why the keyless path drives
    /// the server rather than the CLI.
    async fn run_opencode_server(&self, req: &AgentRequest) -> Result<AgentResponse, AgentError> {
        let base = self.endpoint.trim_end_matches('/');

        // 1. Open a session. `directory` scopes the session to a working dir.
        let session: serde_json::Value = self
            .client
            .post(format!("{base}/session"))
            .header("content-type", "application/json")
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| AgentError::Http(format!("opencode create session: {e}")))?
            .error_for_status()
            .map_err(|e| AgentError::Http(format!("opencode create session: {e}")))?
            .json()
            .await
            .map_err(|e| AgentError::Parse(format!("opencode session json: {e}")))?;
        let session_id = session["id"]
            .as_str()
            .ok_or_else(|| AgentError::Parse("opencode session missing id".to_string()))?;

        // 2. Send the prompt and read the completed assistant message.
        let body = self
            .provider
            .opencode_message_body(&self.model, &req.system, &req.user);
        let resp = self
            .client
            .post(format!("{base}/session/{session_id}/message"))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AgentError::Http(format!("opencode message: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AgentError::Http(format!(
                "opencode message {status}: {text}"
            )));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AgentError::Parse(format!("opencode message json: {e}")))?;

        let content = self
            .provider
            .parse_opencode_message(&json)
            .ok_or_else(|| AgentError::Parse("opencode message had no text part".to_string()))?;
        let (input_tokens, output_tokens) = self.provider.parse_opencode_usage(&json);

        Ok(AgentResponse {
            content,
            provenance: format!("opencode-server:{}", self.model),
            cost_usd: cost_from_usage(input_tokens, output_tokens),
        })
    }
}

impl AgentExecutor for LlmAgentExecutor {
    fn run<'a>(&'a self, req: AgentRequest) -> BoxFuture<'a, Result<AgentResponse, AgentError>> {
        Box::pin(async move {
            // Guard: skip all outbound work when SF_OTEL_DISABLED=1, or when an
            // HTTP provider has no key. The keyless OpenCode server provider has no
            // key by design, so an empty key does NOT disable it (issue #748).
            let disabled = std::env::var("SF_OTEL_DISABLED").as_deref() == Ok("1");
            let missing_http_key = self.api_key.is_empty() && !self.provider.is_keyless();
            if disabled || missing_http_key {
                return Ok(AgentResponse {
                    content: format!("[disabled] {}", req.user),
                    provenance: "sf_otel_disabled".to_string(),
                    cost_usd: 0.0,
                });
            }

            // Keyless OpenCode server: drive `opencode serve` over its session
            // API (no key). The endpoint is the server base URL, not an LLM URL.
            if self.provider.is_keyless() {
                return self.run_opencode_server(&req).await;
            }

            // Build the provider-specific request body (Anthropic Messages vs.
            // OpenAI-compatible chat completions).
            let body = self
                .provider
                .request_body(&self.model, &req.system, &req.user, 4096);

            let mut request = self
                .client
                .post(&self.endpoint)
                .header("content-type", "application/json")
                .json(&body);
            for (name, value) in self.provider.auth_headers(&self.api_key) {
                request = request.header(name, value);
            }

            let resp = request
                .send()
                .await
                .map_err(|e| AgentError::Http(e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(AgentError::Http(format!("{}: {}", status, text)));
            }

            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| AgentError::Parse(e.to_string()))?;

            let content = self
                .provider
                .parse_content(&json)
                .ok_or_else(|| AgentError::Parse("missing assistant content".to_string()))?;

            // Cost accounting: derive the US-dollar cost from the model's
            // reported token usage. We use indicative per-million-token rates;
            // the exact figure is informational for the orchestrator slot cards
            // (issue #712).
            let (input_tokens, output_tokens) = self.provider.parse_usage(&json);
            let cost_usd = cost_from_usage(input_tokens, output_tokens);

            Ok(AgentResponse {
                content,
                provenance: format!("llm:{}:{}", self.provider.as_str(), self.model),
                cost_usd,
            })
        })
    }
}

// ---------------------------------------------------------------------------
// FixtureAgentExecutor — deterministic test double
// ---------------------------------------------------------------------------

/// Deterministic test double for [`AgentExecutor`].
///
/// Every call returns the same `AgentResponse` built from the configured
/// fields.  An atomic counter tracks how many times `run()` was invoked so
/// tests can assert it was called at least once.
pub struct FixtureAgentExecutor {
    /// Content to return in every `AgentResponse`.
    pub content: String,
    /// Provenance tag to return.
    pub provenance: String,
    /// US-dollar cost to report on every `AgentResponse`.
    ///
    /// Non-zero by default so tests observe a populated `costUsd` field on the
    /// work slot the loop publishes (issue #712 acceptance criterion).
    pub cost_usd: f64,
    /// Number of times `run()` has been called.
    call_count: Arc<AtomicUsize>,
}

impl Default for FixtureAgentExecutor {
    fn default() -> Self {
        Self::new(
            "# Fixture content\n\nThis is generated by FixtureAgentExecutor.",
            "fixture:test",
        )
    }
}

/// The fixed cost a [`FixtureAgentExecutor`] reports per call (US dollars).
const FIXTURE_COST_USD: f64 = 0.01;

impl FixtureAgentExecutor {
    /// Create with custom content and provenance.
    pub fn new(content: impl Into<String>, provenance: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            provenance: provenance.into(),
            cost_usd: FIXTURE_COST_USD,
            call_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Return the number of times `run()` has been called.
    pub fn call_count(&self) -> usize {
        self.call_count.load(Ordering::SeqCst)
    }
}

impl AgentExecutor for FixtureAgentExecutor {
    fn run<'a>(&'a self, _req: AgentRequest) -> BoxFuture<'a, Result<AgentResponse, AgentError>> {
        self.call_count.fetch_add(1, Ordering::SeqCst);
        let resp = AgentResponse {
            content: self.content.clone(),
            provenance: self.provenance.clone(),
            cost_usd: self.cost_usd,
        };
        Box::pin(async move { Ok(resp) })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fixture_executor_returns_content() {
        let exec = FixtureAgentExecutor::default();
        let resp = exec
            .run(AgentRequest {
                system: "sys".into(),
                user: "user".into(),
            })
            .await
            .expect("fixture must not fail");
        assert!(!resp.content.is_empty());
        assert_eq!(exec.call_count(), 1);
    }

    /// The fixture reports a non-zero cost so the loop publishes a slot with a
    /// populated `costUsd` field (issue #712 acceptance criterion).
    #[tokio::test]
    async fn fixture_executor_reports_nonzero_cost() {
        let exec = FixtureAgentExecutor::default();
        let resp = exec
            .run(AgentRequest {
                system: "s".into(),
                user: "u".into(),
            })
            .await
            .expect("fixture must not fail");
        assert!(resp.cost_usd > 0.0, "fixture cost must be populated");
    }

    /// Cost is derived from reported input/output token usage.
    #[test]
    fn cost_from_usage_scales_with_tokens() {
        // 1M input @ $1/M + 1M output @ $5/M = $6.
        assert!((cost_from_usage(1_000_000.0, 1_000_000.0) - 6.0).abs() < 1e-9);
        assert_eq!(cost_from_usage(0.0, 0.0), 0.0);
        assert!(cost_from_usage(100.0, 100.0) > 0.0);
    }

    #[tokio::test]
    async fn fixture_executor_call_count() {
        let exec = FixtureAgentExecutor::default();
        for _ in 0..5 {
            exec.run(AgentRequest {
                system: "s".into(),
                user: "u".into(),
            })
            .await
            .unwrap();
        }
        assert_eq!(exec.call_count(), 5);
    }

    /// sf_otel_disabled_prevents_external_calls — acceptance criterion.
    ///
    /// When SF_OTEL_DISABLED=1, the LlmAgentExecutor must skip outbound HTTP
    /// and return the canned response.  In a real test environment we can't
    /// assert "no HTTP calls made" via a mock transport, but we can assert that
    /// the response content matches the disabled sentinel — confirming the guard
    /// fired and no HTTP was attempted.
    #[tokio::test]
    async fn sf_otel_disabled_prevents_external_calls() {
        // Set the guard variable.
        std::env::set_var("SF_OTEL_DISABLED", "1");

        let exec = LlmAgentExecutor::new(
            "fake-key".into(),
            "http://127.0.0.1:0/should-not-be-called".into(),
            "test-model".into(),
        );

        let resp = exec
            .run(AgentRequest {
                system: "sys".into(),
                user: "test prompt".into(),
            })
            .await
            .expect("must succeed under SF_OTEL_DISABLED=1");

        assert_eq!(resp.provenance, "sf_otel_disabled");
        assert!(resp.content.contains("test prompt"));

        // Clean up for other tests.
        std::env::remove_var("SF_OTEL_DISABLED");
    }
}
