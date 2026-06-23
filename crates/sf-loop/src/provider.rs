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
//! - [`LlmProvider::OpenCodeServer`] — **keyless**: talks to a local `opencode
//!   serve` instance over its session API (`POST /session`, then
//!   `POST /session/{id}/message`). A fresh `opencode` install drives OpenCode's
//!   free **Big Pickle** model (`opencode/big-pickle`, GLM-4.6) with **no API key
//!   and no login**, so this is the path CI uses to exercise the whole gardening
//!   loop against a live model without any repo secret (issue #748). The
//!   assistant text comes back in `parts[].text`; usage in `info.tokens`.
//!
//! The two `messages`/`content`-shaped wires (`Anthropic`, `OpenAiCompatible`)
//! require a key; the [`LlmProvider::OpenCodeServer`] path is the keyless one —
//! see [`LlmProvider::is_keyless`], [`LlmProvider::opencode_message_body`], and
//! [`LlmProvider::parse_opencode_message`].
//!
//! Everything here is **pure** request/response shaping (no I/O) so it is unit
//! tested without a network. [`LlmAgentExecutor`](crate::LlmAgentExecutor) calls
//! these to build its bodies, headers, and to parse the assistant text.

/// Which LLM wire protocol the loop speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LlmProvider {
    /// Anthropic Messages API (`x-api-key`, top-level `system`, `content[0].text`).
    ///
    /// The default when `SF_LLM_PROVIDER` is unset or unrecognized.
    #[default]
    Anthropic,
    /// OpenAI-compatible Chat Completions (`Authorization: Bearer`,
    /// `system`-role message, `choices[0].message.content`). Used for an
    /// OpenAI-compatible HTTP gateway when an explicit key is supplied.
    OpenAiCompatible,
    /// Keyless OpenCode server: drives a local `opencode serve` instance over
    /// its session API to reach OpenCode's free Big Pickle (GLM-4.6) model with
    /// **no API key and no login**. This is the keyless path for CI (issue #748).
    /// See [`LlmProvider::opencode_message_body`] and
    /// [`LlmProvider::parse_opencode_message`].
    OpenCodeServer,
}

impl LlmProvider {
    /// Resolve the provider from the `SF_LLM_PROVIDER` value.
    ///
    /// Recognized (case-insensitive) values:
    /// - OpenAI-compatible HTTP: `openai-compatible`, `openai_compatible`,
    ///   `openai`.
    /// - Keyless OpenCode server: `opencode`, `opencode-cli`, `opencode-server`,
    ///   `opencode_server`, `opencodeserver`.
    ///
    /// Anything else — including an unset/empty value — resolves to
    /// [`LlmProvider::Anthropic`], so the default appliance keeps talking to
    /// Anthropic.
    pub fn from_env_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("openai-compatible") | Some("openai_compatible") | Some("openai") => {
                LlmProvider::OpenAiCompatible
            }
            Some("opencode")
            | Some("opencode-cli")
            | Some("opencode-server")
            | Some("opencode_server")
            | Some("opencodeserver") => LlmProvider::OpenCodeServer,
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
            LlmProvider::OpenCodeServer => "opencode-server",
        }
    }

    /// True when this provider needs **no API key** to authenticate.
    ///
    /// Only [`LlmProvider::OpenCodeServer`] is keyless: it drives a local
    /// `opencode serve` instance, which on a fresh install reaches OpenCode's
    /// free Big Pickle model with no login. The two key-based wires
    /// ([`LlmProvider::Anthropic`], [`LlmProvider::OpenAiCompatible`]) always
    /// require a key. The loop's credential-state gate uses this so a keyless
    /// provider selects the real executor even with an empty `SF_LLM_API_KEY`
    /// (issue #748).
    pub fn is_keyless(self) -> bool {
        matches!(self, LlmProvider::OpenCodeServer)
    }

    /// Default `opencode serve` base URL the keyless executor talks to.
    ///
    /// Overridable via `SF_OPENCODE_SERVER`. The workflow boots `opencode serve`
    /// on this port before starting the appliance (issue #748).
    pub const DEFAULT_OPENCODE_SERVER: &'static str = "http://127.0.0.1:4096";

    /// Build the JSON body for `POST /session/{id}/message` against a keyless
    /// `opencode serve` (only meaningful for [`LlmProvider::OpenCodeServer`]).
    ///
    /// The opencode session API takes a `model` (`{providerID, modelID}`) and a
    /// `parts` array. The `model` string is `provider/model` (e.g.
    /// `opencode/big-pickle`); it is split on the first `/`. The system prompt
    /// and the user prompt are folded into a single text part (the session API
    /// has no separate system field), matching the keyless CLI's single-message
    /// shape.
    pub fn opencode_message_body(self, model: &str, system: &str, user: &str) -> serde_json::Value {
        let (provider_id, model_id) = match model.split_once('/') {
            Some((p, m)) => (p, m),
            None => ("opencode", model),
        };
        let text = if system.trim().is_empty() {
            user.to_string()
        } else {
            format!("{system}\n\n{user}")
        };
        serde_json::json!({
            "model": { "providerID": provider_id, "modelID": model_id },
            "parts": [ { "type": "text", "text": text } ],
        })
    }

    /// Extract the assistant text from a keyless `opencode serve` message
    /// response (the `{ "info": {...}, "parts": [...] }` shape).
    ///
    /// Concatenates every `parts[]` entry of `type == "text"`. Returns `None`
    /// when no text part is present.
    pub fn parse_opencode_message(self, json: &serde_json::Value) -> Option<String> {
        let parts = json["parts"].as_array()?;
        let text: String = parts
            .iter()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("");
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    /// Extract `(input_tokens, output_tokens)` from a keyless `opencode serve`
    /// message response (`info.tokens.input` / `info.tokens.output`).
    pub fn parse_opencode_usage(self, json: &serde_json::Value) -> (f64, f64) {
        (
            json["info"]["tokens"]["input"].as_f64().unwrap_or(0.0),
            json["info"]["tokens"]["output"].as_f64().unwrap_or(0.0),
        )
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
            // The OpenCode CLI path never builds an HTTP body (it shells out via
            // `cli_command`), but it shares the OpenAI-compatible message shape
            // for any caller that inspects the body for diagnostics.
            LlmProvider::OpenAiCompatible | LlmProvider::OpenCodeServer => serde_json::json!({
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
            // The keyless OpenCode CLI sends no auth header (no HTTP at all);
            // grouped with the OpenAI-compatible Bearer shape, which it ignores.
            LlmProvider::OpenAiCompatible | LlmProvider::OpenCodeServer => {
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
            LlmProvider::OpenAiCompatible | LlmProvider::OpenCodeServer => {
                json["choices"][0]["message"]["content"].as_str()
            }
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
            LlmProvider::OpenAiCompatible | LlmProvider::OpenCodeServer => (
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

    /// Acceptance criterion (issue #748, keyless rework): the OpenCode server
    /// provider is keyless, builds the session-API message body, and parses the
    /// assistant text + usage from the `{info, parts}` response — the exact shape
    /// a real keyless `opencode serve` returns.
    #[test]
    fn opencode_server_is_keyless_and_shapes_session_message() {
        // Resolves from the documented aliases.
        for v in [
            "opencode",
            "opencode-cli",
            "opencode-server",
            "OpenCode-Server",
        ] {
            assert_eq!(
                LlmProvider::from_env_value(Some(v)),
                LlmProvider::OpenCodeServer,
                "value {v:?} must resolve to OpenCodeServer"
            );
        }

        let provider = LlmProvider::OpenCodeServer;
        assert!(
            provider.is_keyless(),
            "the opencode server path needs no key"
        );
        assert!(!LlmProvider::Anthropic.is_keyless());
        assert!(!LlmProvider::OpenAiCompatible.is_keyless());
        assert_eq!(provider.as_str(), "opencode-server");

        // Request body: model split on '/', system + user folded into one text part.
        let body = provider.opencode_message_body("opencode/big-pickle", "be terse", "say hi");
        assert_eq!(body["model"]["providerID"], "opencode");
        assert_eq!(body["model"]["modelID"], "big-pickle");
        assert_eq!(body["parts"][0]["type"], "text");
        assert_eq!(body["parts"][0]["text"], "be terse\n\nsay hi");
        // A bare model (no '/') defaults the providerID to "opencode".
        let body2 = provider.opencode_message_body("big-pickle", "", "only user");
        assert_eq!(body2["model"]["providerID"], "opencode");
        assert_eq!(body2["model"]["modelID"], "big-pickle");
        assert_eq!(body2["parts"][0]["text"], "only user");

        // Response parse: concatenate text parts; usage from info.tokens.
        let resp = serde_json::json!({
            "info": { "tokens": { "input": 8422, "output": 3 }, "finish": "stop" },
            "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "PO" },
                { "type": "text", "text": "NG" }
            ]
        });
        assert_eq!(
            provider.parse_opencode_message(&resp).as_deref(),
            Some("PONG")
        );
        assert_eq!(provider.parse_opencode_usage(&resp), (8422.0, 3.0));

        // No text part → None (the headless-empty case the runner must surface).
        let empty = serde_json::json!({ "info": {}, "parts": [ { "type": "step-start" } ] });
        assert_eq!(provider.parse_opencode_message(&empty), None);
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
