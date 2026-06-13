//! Agent executor abstraction — LLM call seam for the gardening loop.
//!
//! [`AgentExecutor`] is the trait through which the six gardening steps
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
/// All six gardening steps call [`AgentExecutor::run`] to produce their page
/// revision content.  Tests inject a [`FixtureAgentExecutor`]; the daemon
/// injects a [`LlmAgentExecutor`].
pub trait AgentExecutor: Send + Sync {
    /// Execute a single agent request and return the response.
    fn run<'a>(&'a self, req: AgentRequest) -> BoxFuture<'a, Result<AgentResponse, AgentError>>;
}

// ---------------------------------------------------------------------------
// LlmAgentExecutor — real implementation
// ---------------------------------------------------------------------------

/// Real LLM executor that calls the configured API endpoint.
///
/// Controlled by:
/// - `SF_LLM_API_KEY`   — authentication header value.
/// - `SF_LLM_ENDPOINT`  — URL to POST to.
/// - `SF_LLM_MODEL`     — model name.
/// - `SF_OTEL_DISABLED` — when `"1"`, all HTTP is skipped.
pub struct LlmAgentExecutor {
    api_key: String,
    endpoint: String,
    model: String,
    client: reqwest::Client,
}

impl LlmAgentExecutor {
    /// Create from the given config fields.
    pub fn new(api_key: String, endpoint: String, model: String) -> Self {
        Self {
            api_key,
            endpoint,
            model,
            client: reqwest::Client::new(),
        }
    }
}

impl AgentExecutor for LlmAgentExecutor {
    fn run<'a>(&'a self, req: AgentRequest) -> BoxFuture<'a, Result<AgentResponse, AgentError>> {
        Box::pin(async move {
            // Guard: skip all outbound calls when SF_OTEL_DISABLED=1.
            if std::env::var("SF_OTEL_DISABLED").as_deref() == Ok("1") || self.api_key.is_empty() {
                return Ok(AgentResponse {
                    content: format!("[disabled] {}", req.user),
                    provenance: "sf_otel_disabled".to_string(),
                });
            }

            // Build the Anthropic Messages API request body.
            let body = serde_json::json!({
                "model": self.model,
                "max_tokens": 4096,
                "system": req.system,
                "messages": [{"role": "user", "content": req.user}]
            });

            let resp = self
                .client
                .post(&self.endpoint)
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
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

            let content = json["content"][0]["text"]
                .as_str()
                .ok_or_else(|| AgentError::Parse("missing content[0].text".to_string()))?
                .to_string();

            Ok(AgentResponse {
                content,
                provenance: format!("llm:{}", self.model),
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

impl FixtureAgentExecutor {
    /// Create with custom content and provenance.
    pub fn new(content: impl Into<String>, provenance: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            provenance: provenance.into(),
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
