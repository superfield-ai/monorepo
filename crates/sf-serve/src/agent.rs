//! In-process agent executor for the studio agent-chat WebSocket (`WS /studio/ws`).
//!
//! # Why this lives in `sf-serve` (issue #687)
//!
//! The gardening loop's [`AgentExecutor`] trait and its `LlmAgentExecutor` /
//! `FixtureAgentExecutor` implementations live in `sf-loop`
//! (`crates/sf-loop/src/agent.rs`). `sf-loop` **depends on** `sf-serve`
//! (`sf-serve = { path = "../sf-serve" }`), so `sf-serve` cannot depend on
//! `sf-loop` without a dependency cycle. Rather than refactor the executor seam
//! into a shared lower crate (a separable, larger effort), this module provides
//! a small, self-contained executor in `sf-serve` that mirrors `sf-loop`'s
//! fixture-fallback semantics so the WebSocket handler can round-trip a real
//! message with the product agent.
//!
//! # Fixture-fallback semantics (mirrors `sf_loop::daemon_runtime::build_executor`)
//!
//! [`StudioAgent::from_env`] reads the same env vars the gardening loop does:
//!
//! - `SF_LLM_API_KEY` — when empty (or `SF_OTEL_DISABLED=1`), no outbound HTTP is
//!   made; a deterministic fixture reply is returned. This is the CI path (no LLM
//!   key), matching how `build_executor` falls back to `FixtureAgentExecutor`.
//! - `SF_LLM_ENDPOINT` — the Anthropic Messages API URL to POST to.
//! - `SF_LLM_MODEL` — the model name.
//!
//! With a real key present, [`StudioAgent::reply`] POSTs an Anthropic Messages
//! API request and returns the assistant text — the same wire shape
//! `LlmAgentExecutor` uses.

use std::env;

/// Default Anthropic Messages API endpoint (matches the gardening loop default).
const DEFAULT_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
/// Default model (matches the gardening loop default).
const DEFAULT_MODEL: &str = "claude-haiku-4-5-20251001";

/// Error surfaced to the client as a `{"type":"error"}` frame.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    /// HTTP or network failure talking to the LLM endpoint.
    #[error("agent http error: {0}")]
    Http(String),
    /// The LLM response did not match the expected shape.
    #[error("agent parse error: {0}")]
    Parse(String),
}

/// In-process agent for the studio chat WebSocket.
///
/// Built once per connection from the environment (cheap — no network on
/// construction). Reuses one [`reqwest::Client`] for the connection's turns.
#[derive(Clone)]
pub struct StudioAgent {
    api_key: String,
    endpoint: String,
    model: String,
    client: reqwest::Client,
}

impl StudioAgent {
    /// Build from the process environment, mirroring the gardening loop config.
    ///
    /// When `SF_LLM_API_KEY` is empty the agent runs in **fixture mode** (no
    /// outbound HTTP); see [`StudioAgent::reply`].
    pub fn from_env() -> Self {
        let api_key = env::var("SF_LLM_API_KEY").unwrap_or_default();
        let endpoint = env::var("SF_LLM_ENDPOINT")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
        let model = env::var("SF_LLM_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        Self {
            api_key,
            endpoint,
            model,
            client: reqwest::Client::new(),
        }
    }

    /// Build directly from explicit fields (test-only seam).
    ///
    /// `from_env` reads the process environment, which makes credential-state
    /// assertions racy under parallel tests. This constructor lets a test pin
    /// the key value without touching env vars (issue #714).
    #[cfg(test)]
    fn from_parts(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            endpoint: DEFAULT_ENDPOINT.to_string(),
            model: DEFAULT_MODEL.to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// True when a usable LLM credential is configured (`SF_LLM_API_KEY` is a
    /// non-empty value).
    ///
    /// This mirrors `sf_loop::LlmCredentialState`: a configured key selects the
    /// real LLM path (`reply` POSTs to the endpoint); an unconfigured one falls
    /// back to the fixture. The studio agent and the gardening loop therefore
    /// agree on first-run credential state (issue #714).
    pub fn is_llm_configured(&self) -> bool {
        !self.api_key.trim().is_empty()
    }

    /// True when the agent will answer from a local fixture (no LLM call).
    ///
    /// This is the CI / no-key path. It matches `build_executor`'s fall back to
    /// `FixtureAgentExecutor` when `SF_LLM_API_KEY` is empty. Note that
    /// `SF_OTEL_DISABLED=1` also forces fixture mode (offline CI) even when a
    /// key is present — see [`Self::is_llm_configured`] for the credential-only
    /// view.
    pub fn is_fixture(&self) -> bool {
        !self.is_llm_configured() || env::var("SF_OTEL_DISABLED").as_deref() == Ok("1")
    }

    /// Produce a reply to one chat `message`, scoped to `workspace_id`.
    ///
    /// In fixture mode the reply is deterministic and references the workspace
    /// so the round-trip is observable end-to-end without an LLM key. With a key
    /// present, this POSTs an Anthropic Messages API request and returns the
    /// assistant text.
    pub async fn reply(&self, message: &str, workspace_id: &str) -> Result<String, AgentError> {
        if self.is_fixture() {
            return Ok(fixture_reply(message, workspace_id));
        }

        let system = format!(
            "You are the Superfield product agent for workspace {workspace_id}. \
             Answer concisely about the workspace's authored knowledge."
        );
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": 1024,
            "system": system,
            "messages": [{"role": "user", "content": message}],
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
            return Err(AgentError::Http(format!("{status}: {text}")));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AgentError::Parse(e.to_string()))?;

        let content = json["content"][0]["text"]
            .as_str()
            .ok_or_else(|| AgentError::Parse("missing content[0].text".to_string()))?
            .to_string();

        Ok(content)
    }
}

/// Deterministic fixture reply used when no LLM key is configured.
///
/// References the workspace and echoes the user's message so a WS test (and the
/// browser, in CI) can assert a real round-trip without an LLM call. Long enough
/// to exceed the 126-byte single-frame WS boundary so the streaming path
/// exercises multiple `chunk` frames.
fn fixture_reply(message: &str, workspace_id: &str) -> String {
    format!(
        "Hello from the Superfield product agent (workspace {workspace_id}). \
         You asked: \"{message}\". I do not have a language model configured in \
         this environment, so this is a deterministic fixture reply that still \
         proves the agent-chat round-trip works end to end."
    )
}

/// Split an agent reply into streamable chunks for the `chunk` frame protocol.
///
/// Chunks on whitespace so the client appends incrementally (and so the WS test
/// observes more than one `chunk` frame). Each chunk keeps its trailing space so
/// the reassembled text equals the original reply.
pub fn chunk_reply(reply: &str) -> Vec<String> {
    if reply.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for word in reply.split_inclusive(char::is_whitespace) {
        current.push_str(word);
        // Flush in modest chunks so the stream is observably incremental.
        if current.len() >= 24 {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fixture_mode_when_no_key() {
        // Ensure no key in the environment for this assertion.
        std::env::remove_var("SF_LLM_API_KEY");
        let agent = StudioAgent::from_env();
        assert!(agent.is_fixture(), "no key must select fixture mode");
        let reply = agent
            .reply("how does ingest work?", "ws-123")
            .await
            .unwrap();
        assert!(reply.contains("ws-123"), "reply scopes the workspace");
        assert!(
            reply.contains("how does ingest work?"),
            "reply echoes the user message"
        );
    }

    /// With SF_LLM_API_KEY set, the studio agent selects the REAL LLM path
    /// (not the fixture) — issue #714 acceptance criterion 1 for the studio
    /// agent. Asserted on a key-pinned agent so SF_OTEL_DISABLED in the test
    /// environment does not mask the credential-state view.
    #[test]
    fn configured_key_selects_real_llm_path() {
        let agent = StudioAgent::from_parts("sk-ant-SECRET-studio-key");
        assert!(
            agent.is_llm_configured(),
            "a non-empty key must report the LLM as configured"
        );
        let blank = StudioAgent::from_parts("   ");
        assert!(
            !blank.is_llm_configured(),
            "a blank key must report the LLM as unconfigured"
        );
        assert!(blank.is_fixture(), "a blank key must select fixture mode");
    }

    /// The key value never appears in the fixture reply (which is the only text
    /// the unconfigured studio agent emits) — issue #714 no-leak guarantee.
    #[tokio::test]
    async fn fixture_reply_never_contains_key() {
        let reply = fixture_reply("a question", "ws-1");
        assert!(!reply.contains("sk-ant"), "fixture reply must carry no key");
    }

    #[test]
    fn chunk_reply_reassembles_to_original() {
        let reply = fixture_reply("a question", "ws-xyz");
        let chunks = chunk_reply(&reply);
        assert!(chunks.len() > 1, "long reply yields multiple chunks");
        assert_eq!(chunks.concat(), reply, "chunks reassemble losslessly");
    }

    #[test]
    fn chunk_reply_empty_is_empty() {
        assert!(chunk_reply("").is_empty());
    }
}
