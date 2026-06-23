//! LLM provider wire shaping — Anthropic Messages vs. OpenAI-compatible chat.
//!
//! The gardening loop talks to one of two HTTP wire protocols, selected by
//! `SF_LLM_PROVIDER`:
//!
//! - [`LlmProvider::Anthropic`] (the default) — the Anthropic Messages API:
//!   `x-api-key` + `anthropic-version` headers, a top-level `system` field, and
//!   a response shaped `content[0].text`.
//! - [`LlmProvider::OpenAiCompatible`] — the OpenAI Chat Completions wire shape
//!   (`/v1/chat/completions`): an `Authorization: Bearer <key>` header, the
//!   system prompt folded into the messages array as a `system`-role message,
//!   and a response shaped `choices[0].message.content`.
//!
//! The OpenAI-compatible path is what lets the appliance drive the loop with
//! OpenCode's free **Big Pickle** model (`opencode/big-pickle`, GLM-4.6) via
//! Zen's OpenAI-compatible endpoint (`https://opencode.ai/zen/v1/chat/completions`)
//! using a free `OPENCODE_ZEN_API_KEY` — no Anthropic key, so CI can exercise the
//! whole loop without a paid secret (issue #748).
//!
//! Everything here is **pure** request/response shaping (no I/O) so it is unit
//! tested without a network: [`LlmAgentExecutor`](crate::LlmAgentExecutor) calls
//! these to build its body, headers, and to parse the assistant text.

/// Which LLM wire protocol the loop speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LlmProvider {
    /// Anthropic Messages API (`x-api-key`, top-level `system`, `content[0].text`).
    ///
    /// The default when `SF_LLM_PROVIDER` is unset or unrecognized.
    #[default]
    Anthropic,
    /// OpenAI-compatible Chat Completions (`Authorization: Bearer`,
    /// `system`-role message, `choices[0].message.content`). Used for the free
    /// OpenCode Big Pickle (GLM-4.6) path via Zen.
    OpenAiCompatible,
}

impl LlmProvider {
    /// Resolve the provider from the `SF_LLM_PROVIDER` value.
    ///
    /// Recognized (case-insensitive) values for the OpenAI-compatible path:
    /// `openai-compatible`, `openai_compatible`, `openai`. Anything else —
    /// including an unset/empty value — resolves to [`LlmProvider::Anthropic`],
    /// so the default appliance keeps talking to Anthropic.
    pub fn from_env_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("openai-compatible") | Some("openai_compatible") | Some("openai") => {
                LlmProvider::OpenAiCompatible
            }
            _ => LlmProvider::Anthropic,
        }
    }

    /// Resolve the provider from the process environment (`SF_LLM_PROVIDER`).
    pub fn from_env() -> Self {
        Self::from_env_value(std::env::var("SF_LLM_PROVIDER").ok().as_deref())
    }

    /// A stable lowercase tag for logs and provenance (never a secret).
    pub fn as_str(self) -> &'static str {
        match self {
            LlmProvider::Anthropic => "anthropic",
            LlmProvider::OpenAiCompatible => "openai-compatible",
        }
    }

    /// Build the JSON request body for `system` + `user` prompts.
    ///
    /// - Anthropic: a top-level `system` string and a single user message.
    /// - OpenAI-compatible: `system` and `user` both folded into `messages`.
    pub fn request_body(
        self,
        model: &str,
        system: &str,
        user: &str,
        max_tokens: u32,
    ) -> serde_json::Value {
        match self {
            LlmProvider::Anthropic => serde_json::json!({
                "model": model,
                "max_tokens": max_tokens,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            }),
            LlmProvider::OpenAiCompatible => serde_json::json!({
                "model": model,
                "max_tokens": max_tokens,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            }),
        }
    }

    /// The HTTP auth/version headers for this provider as `(name, value)` pairs.
    ///
    /// - Anthropic: `x-api-key: <key>` and `anthropic-version: 2023-06-01`.
    /// - OpenAI-compatible: `Authorization: Bearer <key>`.
    ///
    /// `content-type: application/json` is set by the JSON body builder and is
    /// not included here.
    pub fn auth_headers(self, api_key: &str) -> Vec<(&'static str, String)> {
        match self {
            LlmProvider::Anthropic => vec![
                ("x-api-key", api_key.to_string()),
                ("anthropic-version", "2023-06-01".to_string()),
            ],
            LlmProvider::OpenAiCompatible => {
                vec![("authorization", format!("Bearer {api_key}"))]
            }
        }
    }

    /// Extract the assistant text from a parsed JSON response.
    ///
    /// - Anthropic: `content[0].text`.
    /// - OpenAI-compatible: `choices[0].message.content`.
    pub fn parse_content(self, json: &serde_json::Value) -> Option<String> {
        let text = match self {
            LlmProvider::Anthropic => json["content"][0]["text"].as_str(),
            LlmProvider::OpenAiCompatible => json["choices"][0]["message"]["content"].as_str(),
        };
        text.map(str::to_string)
    }

    /// Extract `(input_tokens, output_tokens)` from a parsed JSON response.
    ///
    /// - Anthropic: `usage.input_tokens` / `usage.output_tokens`.
    /// - OpenAI-compatible: `usage.prompt_tokens` / `usage.completion_tokens`.
    ///
    /// Missing fields default to `0.0` so cost accounting degrades to zero
    /// rather than failing the call.
    pub fn parse_usage(self, json: &serde_json::Value) -> (f64, f64) {
        match self {
            LlmProvider::Anthropic => (
                json["usage"]["input_tokens"].as_f64().unwrap_or(0.0),
                json["usage"]["output_tokens"].as_f64().unwrap_or(0.0),
            ),
            LlmProvider::OpenAiCompatible => (
                json["usage"]["prompt_tokens"].as_f64().unwrap_or(0.0),
                json["usage"]["completion_tokens"].as_f64().unwrap_or(0.0),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `SF_LLM_PROVIDER` defaults to Anthropic when unset or unrecognized.
    #[test]
    fn provider_defaults_to_anthropic() {
        assert_eq!(LlmProvider::from_env_value(None), LlmProvider::Anthropic);
        assert_eq!(
            LlmProvider::from_env_value(Some("")),
            LlmProvider::Anthropic
        );
        assert_eq!(
            LlmProvider::from_env_value(Some("nonsense")),
            LlmProvider::Anthropic
        );
        assert_eq!(LlmProvider::default(), LlmProvider::Anthropic);
    }

    /// The OpenAI-compatible aliases all resolve to the OpenAI path.
    #[test]
    fn provider_resolves_openai_compatible_aliases() {
        for v in [
            "openai-compatible",
            "OpenAI-Compatible",
            "openai_compatible",
            "openai",
            " openai ",
        ] {
            assert_eq!(
                LlmProvider::from_env_value(Some(v)),
                LlmProvider::OpenAiCompatible,
                "value {v:?} must resolve to OpenAiCompatible"
            );
        }
    }

    /// Acceptance criterion (issue #748): the OpenAI-compatible provider path
    /// sends `Authorization: Bearer <key>` and parses `choices[0].message.content`.
    #[test]
    fn openai_compatible_request_uses_bearer_auth_and_parses_choices() {
        let provider = LlmProvider::OpenAiCompatible;

        // Auth header: Authorization: Bearer <key> (and NOT x-api-key).
        let headers = provider.auth_headers("free-zen-key");
        assert!(
            headers
                .iter()
                .any(|(k, v)| *k == "authorization" && v == "Bearer free-zen-key"),
            "openai-compatible must send Authorization: Bearer <key>, got {headers:?}"
        );
        assert!(
            !headers.iter().any(|(k, _)| *k == "x-api-key"),
            "openai-compatible must not send the Anthropic x-api-key header"
        );

        // Request body: system folded into messages as a system-role entry.
        let body = provider.request_body("opencode/big-pickle", "sys", "hi", 4096);
        assert_eq!(body["model"], "opencode/big-pickle");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "sys");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "hi");
        assert!(
            body.get("system").is_none(),
            "openai-compatible must not use a top-level system field"
        );

        // Response parse: choices[0].message.content.
        let resp = serde_json::json!({
            "choices": [{"message": {"role": "assistant", "content": "the answer"}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 34}
        });
        assert_eq!(provider.parse_content(&resp).as_deref(), Some("the answer"));
        assert_eq!(provider.parse_usage(&resp), (12.0, 34.0));
    }

    /// The Anthropic path keeps its Messages-API wire shape unchanged.
    #[test]
    fn anthropic_request_uses_x_api_key_and_parses_content() {
        let provider = LlmProvider::Anthropic;

        let headers = provider.auth_headers("sk-ant-123");
        assert!(headers
            .iter()
            .any(|(k, v)| *k == "x-api-key" && v == "sk-ant-123"));
        assert!(headers
            .iter()
            .any(|(k, v)| *k == "anthropic-version" && v == "2023-06-01"));
        assert!(
            !headers.iter().any(|(k, _)| *k == "authorization"),
            "anthropic must not send a Bearer Authorization header"
        );

        let body = provider.request_body("claude-haiku-4-5-20251001", "sys", "hi", 4096);
        assert_eq!(body["system"], "sys");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "hi");

        let resp = serde_json::json!({
            "content": [{"type": "text", "text": "anthropic answer"}],
            "usage": {"input_tokens": 5, "output_tokens": 7}
        });
        assert_eq!(
            provider.parse_content(&resp).as_deref(),
            Some("anthropic answer")
        );
        assert_eq!(provider.parse_usage(&resp), (5.0, 7.0));
    }
}
