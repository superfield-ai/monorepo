//! Studio agent-chat WebSocket (`WS /studio/ws`).
//!
//! # Real agent stream (issue #687, phase `studio-ws-agent-stream`)
//!
//! This module backs the Product-tab chat. The frontend `WsChatController`
//! (`packages/control/apps/src/controllers/ChatController.ts`) connects to
//! `WS /studio/ws` and round-trips messages with the product agent so Dana can
//! converse about her authored knowledge from the browser. Scout #695 wired the
//! **route-registration + frame-protocol seam**; this feature drops the real
//! agent stream into [`agent_stream`] (replacing the no-op `stub_agent_stream`)
//! *without* touching [`crate::build_router`]'s merge chain.
//!
//! # Wire contract (the frame protocol the controller speaks)
//!
//! The client and server exchange newline-free JSON text frames. Inbound
//! (client → server):
//!
//! ```text
//!   {"type":"turn",  "message":"…", "mode":"design"|"question"}
//!   {"type":"steer", "context":"…", "sessionId":"…"}
//! ```
//!
//! Outbound (server → client) — the three frame kinds the controller's
//! `handleMessage` switch recognises:
//!
//! ```text
//!   {"type":"chunk", "text":"…"}          // append `text` to the assistant msg
//!   {"type":"done"}                        // mark the turn complete (idle)
//!   {"type":"error", "message":"…"}        // mark the turn failed
//! ```
//!
//! Unknown inbound frames are answered with an `error` frame; the controller
//! ignores any outbound frame whose `type` is none of the three above.
//!
//! # Per-turn loop
//!
//! After the handshake, [`agent_stream`] reads inbound frames in a loop. For
//! each `turn` (or `steer`) it asks the [`StudioAgent`] for a reply, streams the
//! reply as one or more `chunk` frames, then a `done` frame. An agent failure is
//! surfaced as an `error` frame; the socket stays open for the next turn. The
//! socket closes when the client closes it (or the read errors).
//!
//! # Agent runtime source (resolved by #687)
//!
//! The agent runs **in-process** in `sf-serve` via [`crate::agent::StudioAgent`].
//! The gardening loop's `AgentExecutor` lives in `sf-loop`, but `sf-loop`
//! depends on `sf-serve`, so reusing it here would create a dependency cycle.
//! [`StudioAgent`] mirrors `sf-loop`'s fixture-fallback semantics: with no
//! `SF_LLM_API_KEY` it answers from a deterministic fixture (the CI path), and
//! with a key it POSTs the Anthropic Messages API — the same wire shape the
//! gardening loop's `LlmAgentExecutor` uses.
//!
//! # Auth/session scope
//!
//! This route is auth-wrapped by [`crate::build_router`] (the
//! [`sf_auth::AuthContext`] extension is present), matching the SSE studio
//! routes. [`studio_ws`] reads the authenticated `workspace_id` and scopes the
//! agent session to it, never trusting a workspace from the frame body.
//!
//! # Additive-merge contract (issue #677)
//!
//! This is its own route module so it registers without colliding on
//! [`crate::build_router`]'s merge chain (the `additive_route_seam` test panics
//! at build on any axum route collision). It is `.merge(...)`d once into the
//! protected (auth-wrapped) group. `/studio/ws` is a fresh path owned solely by
//! this module.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Control Webapp.
//! - Issue #687 (this feature), #695 (the scout seam).

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::Response,
    routing::any,
    Extension, Router,
};
use serde_json::{json, Value};
use sf_auth::AuthContext;

use crate::agent::{chunk_reply, StudioAgent};
use crate::state::AppState;

/// `WS /studio/ws` — agent-chat WebSocket upgrade handler.
///
/// Completes the WebSocket handshake (`101 Switching Protocols`), then runs the
/// per-turn agent stream ([`agent_stream`]) scoped to the authenticated
/// workspace. The [`AuthContext`] is supplied by the auth middleware
/// ([`crate::build_router`]); it is extracted optionally so the handler is
/// directly testable without the auth layer (tests fall back to a placeholder
/// workspace).
pub async fn studio_ws(ws: WebSocketUpgrade, ctx: Option<Extension<AuthContext>>) -> Response {
    let workspace_id = ctx
        .map(|Extension(c)| c.workspace_id.to_string())
        .unwrap_or_else(|| "unscoped".to_string());
    ws.on_upgrade(move |socket| agent_stream(socket, workspace_id))
}

/// Real per-turn agent stream — the seam #687 wired in over scout #695's stub.
///
/// Reads inbound `turn`/`steer` frames in a loop; for each, streams the agent's
/// reply as `chunk` frames terminated by a `done` frame, or an `error` frame on
/// failure. Returns when the client closes the socket or a read fails.
async fn agent_stream(mut socket: WebSocket, workspace_id: String) {
    let agent = StudioAgent::from_env();

    while let Some(frame) = socket.recv().await {
        let msg = match frame {
            Ok(m) => m,
            Err(_) => break,
        };

        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            // Ping/Pong/Binary: ignore and keep the per-turn loop alive.
            _ => continue,
        };

        // Extract the prompt for this turn from the inbound frame.
        let prompt = match parse_turn(&text) {
            Some(p) => p,
            None => {
                // Unknown / malformed inbound frame — surface as an error so the
                // controller leaves `streaming` rather than hanging.
                if send_error(&mut socket, "unrecognised frame").await.is_err() {
                    break;
                }
                continue;
            }
        };

        match agent.reply(&prompt, &workspace_id).await {
            Ok(reply) => {
                if stream_reply(&mut socket, &reply).await.is_err() {
                    break;
                }
            }
            Err(e) => {
                if send_error(&mut socket, &e.to_string()).await.is_err() {
                    break;
                }
            }
        }
    }
}

/// Pull the user prompt out of an inbound `turn` or `steer` frame.
///
/// Returns `None` for frames the protocol does not define (the caller answers
/// those with an `error` frame).
fn parse_turn(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    match v.get("type").and_then(Value::as_str)? {
        "turn" => v.get("message").and_then(Value::as_str).map(str::to_owned),
        "steer" => v.get("context").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

/// Stream `reply` as one or more `chunk` frames, terminated by a `done` frame.
async fn stream_reply(socket: &mut WebSocket, reply: &str) -> Result<(), axum::Error> {
    for chunk in chunk_reply(reply) {
        let frame = json!({ "type": "chunk", "text": chunk });
        socket.send(Message::Text(frame.to_string().into())).await?;
    }
    let done = json!({ "type": "done" });
    socket.send(Message::Text(done.to_string().into())).await
}

/// Send an `{"type":"error","message":…}` frame.
async fn send_error(socket: &mut WebSocket, message: &str) -> Result<(), axum::Error> {
    let frame = json!({ "type": "error", "message": message });
    socket.send(Message::Text(frame.to_string().into())).await
}

/// Build the studio agent-chat WebSocket router.
///
/// Registers **only** `WS /studio/ws` — a fresh path owned solely by this
/// module. `/studio/chat` is owned by [`super::studio`], so it is intentionally
/// not registered here to keep the additive-merge contract collision-free.
///
/// All routes here are wrapped in the auth middleware by the caller
/// ([`crate::build_router`]).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/studio/ws", any(studio_ws))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use sqlx::postgres::PgPoolOptions;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use crate::state::AppState;

    /// A lazily-connected pool — enough to build [`AppState`]; the WS handler
    /// touches neither the pool nor the orchestrator state.
    fn lazy_state() -> AppState {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy("postgres://localhost/placeholder")
            .expect("lazy pool");
        let session_store = sf_auth::SessionStore::new(pool.clone(), Some(3600));
        AppState::new(pool, session_store)
    }

    /// Bind the WS router (no auth layer — the upgrade handler reads the
    /// [`sf_auth::AuthContext`] optionally and falls back to a placeholder
    /// workspace in tests) to a random loopback port and return the bound
    /// address. The server task runs until the test process exits.
    async fn spawn_ws_server() -> SocketAddr {
        // The fixture agent is selected when no LLM key is configured; force it
        // so the WS tests never make an outbound call regardless of the host
        // environment.
        std::env::remove_var("SF_LLM_API_KEY");
        let router = super::router(lazy_state());
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        addr
    }

    /// A raw-TCP WebSocket client: completes the RFC 6455 handshake, then lets
    /// the test send masked client text frames and read unmasked server frames.
    ///
    /// Avoids pulling in a WebSocket client crate — the protocol surface the
    /// handler uses (text frames, close) is small and well-known, keeping the
    /// dev-scout's flat dependency surface.
    struct RawWs {
        stream: TcpStream,
        /// Bytes read from the socket but not yet decoded into frames.
        buf: Vec<u8>,
    }

    impl RawWs {
        /// Connect and complete the WS upgrade handshake. Returns the HTTP
        /// response head (status line + headers) alongside the client.
        async fn connect(addr: SocketAddr) -> (String, Self) {
            let mut stream = TcpStream::connect(addr).await.expect("connect");
            // `dGhlIHNhbXBsZSBub25jZQ==` is the canonical RFC 6455 example key.
            let req = "GET /studio/ws HTTP/1.1\r\n\
                 Host: 127.0.0.1\r\n\
                 Connection: Upgrade\r\n\
                 Upgrade: websocket\r\n\
                 Sec-WebSocket-Version: 13\r\n\
                 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                 \r\n";
            stream.write_all(req.as_bytes()).await.expect("write req");

            // Read until the end of the HTTP response head.
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let n = stream.read(&mut chunk).await.expect("read head");
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if find_subsequence(&buf, b"\r\n\r\n").is_some() {
                    break;
                }
            }
            let head_end = find_subsequence(&buf, b"\r\n\r\n")
                .map(|i| i + 4)
                .unwrap_or(buf.len());
            let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
            let leftover = buf[head_end..].to_vec();
            (
                head,
                RawWs {
                    stream,
                    buf: leftover,
                },
            )
        }

        /// Send a masked client text frame (RFC 6455 requires client→server
        /// frames to be masked). Handles the extended-length header for payloads
        /// of 126+ bytes so longer messages still encode correctly.
        async fn send_text(&mut self, text: &str) {
            let payload = text.as_bytes();
            let mut frame = vec![0x81u8]; // FIN + text opcode.
            let mask = [0x12u8, 0x34, 0x56, 0x78];
            let len = payload.len();
            if len < 126 {
                frame.push(0x80 | len as u8);
            } else if len < 65536 {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(len as u16).to_be_bytes());
            } else {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(len as u64).to_be_bytes());
            }
            frame.extend_from_slice(&mask);
            for (i, b) in payload.iter().enumerate() {
                frame.push(b ^ mask[i % 4]);
            }
            self.stream.write_all(&frame).await.expect("write frame");
        }

        /// Read server text frames until a `done` or `error` frame is seen,
        /// returning the decoded JSON `type` values in order.
        ///
        /// Handles the 2-byte and 16-bit extended-length headers so multi-frame
        /// agent replies (which exceed the 126-byte single-frame boundary)
        /// decode correctly.
        async fn read_until_terminal(&mut self) -> Vec<String> {
            let mut types = Vec::new();
            while let Some((opcode, payload)) = self.next_frame().await {
                if opcode == 0x8 {
                    // Close frame from the server.
                    break;
                }
                if opcode == 0x1 {
                    let text = String::from_utf8_lossy(&payload).into_owned();
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
                            types.push(t.to_string());
                            if t == "done" || t == "error" {
                                break;
                            }
                        }
                    }
                }
            }
            types
        }

        /// Decode the next server frame, refilling the buffer from the socket as
        /// needed. Returns `(opcode, payload)` or `None` on EOF.
        async fn next_frame(&mut self) -> Option<(u8, Vec<u8>)> {
            loop {
                if self.buf.len() >= 2 {
                    let opcode = self.buf[0] & 0x0f;
                    let masked = self.buf[1] & 0x80 != 0;
                    let len7 = (self.buf[1] & 0x7f) as usize;
                    let (header_len, payload_len) = if len7 < 126 {
                        (2usize, len7)
                    } else if len7 == 126 && self.buf.len() >= 4 {
                        let l = u16::from_be_bytes([self.buf[2], self.buf[3]]) as usize;
                        (4usize, l)
                    } else if len7 == 127 && self.buf.len() >= 10 {
                        let mut b = [0u8; 8];
                        b.copy_from_slice(&self.buf[2..10]);
                        (10usize, u64::from_be_bytes(b) as usize)
                    } else {
                        // Need more header bytes.
                        if !self.refill().await {
                            return None;
                        }
                        continue;
                    };
                    // Server frames are never masked.
                    debug_assert!(!masked, "server frames must be unmasked");
                    if self.buf.len() >= header_len + payload_len {
                        let payload = self.buf[header_len..header_len + payload_len].to_vec();
                        self.buf.drain(..header_len + payload_len);
                        return Some((opcode, payload));
                    }
                }
                if !self.refill().await {
                    return None;
                }
            }
        }

        /// Read more bytes from the socket into the buffer. Returns false on EOF.
        async fn refill(&mut self) -> bool {
            let mut chunk = [0u8; 1024];
            match self.stream.read(&mut chunk).await {
                Ok(0) | Err(_) => false,
                Ok(n) => {
                    self.buf.extend_from_slice(&chunk[..n]);
                    true
                }
            }
        }
    }

    fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    /// Acceptance / test plan: a WS upgrade request to `/studio/ws` completes
    /// the handshake (`101 Switching Protocols`).
    #[tokio::test]
    async fn studio_ws_upgrade_returns_101() {
        let addr = spawn_ws_server().await;
        let (head, _ws) = RawWs::connect(addr).await;
        assert!(
            head.starts_with("HTTP/1.1 101"),
            "expected 101 Switching Protocols, got head:\n{head}"
        );
    }

    /// Acceptance / test plan: a sent `turn` message yields one or more
    /// `{"type":"chunk"}` frames terminated by a `{"type":"done"}` frame.
    #[tokio::test]
    async fn studio_ws_streams_chunk_done_frames() {
        let addr = spawn_ws_server().await;
        let (head, mut ws) = RawWs::connect(addr).await;
        assert!(
            head.starts_with("HTTP/1.1 101"),
            "handshake failed:\n{head}"
        );

        ws.send_text(r#"{"type":"turn","message":"hello agent","mode":"question"}"#)
            .await;

        let types = ws.read_until_terminal().await;
        assert!(
            types.iter().any(|t| t == "chunk"),
            "expected at least one chunk frame, got: {types:?}"
        );
        assert_eq!(
            types.last().map(String::as_str),
            Some("done"),
            "expected the turn to terminate with a done frame, got: {types:?}"
        );
    }

    /// Acceptance / test plan: an unrecognised inbound frame is surfaced to the
    /// client as a `{"type":"error"}` frame (the error-frame path).
    #[tokio::test]
    async fn studio_ws_error_frame_on_failure() {
        let addr = spawn_ws_server().await;
        let (head, mut ws) = RawWs::connect(addr).await;
        assert!(
            head.starts_with("HTTP/1.1 101"),
            "handshake failed:\n{head}"
        );

        // A frame whose `type` is not part of the protocol: the handler answers
        // with an error frame rather than a chunk/done pair.
        ws.send_text(r#"{"type":"bogus","message":"nope"}"#).await;

        let types = ws.read_until_terminal().await;
        assert_eq!(
            types.last().map(String::as_str),
            Some("error"),
            "expected an error frame for an unrecognised inbound frame, got: {types:?}"
        );
    }

    /// The WS seam module's `router(state)` constructor builds in isolation —
    /// guards the additive-merge signature.
    #[tokio::test]
    async fn ws_router_builds_in_isolation() {
        let _router = super::router(lazy_state());
    }
}
