//! Studio agent-chat WebSocket seam (`WS /studio/ws`, `POST /studio/chat`).
//!
//! # dev-scout seam (issue #695, downstream feature #687, phase `studio-ws-agent-stream`)
//!
//! This module is the **stub** for the studio agent-chat surface. The frontend
//! `WsChatController`
//! (`packages/control/apps/src/controllers/ChatController.ts`) already speaks
//! the `{type:"chunk"|"done"|"error"}` frame protocol over `WS /studio/ws`, but
//! no Rust-side agent runtime exists yet. This scout wires the **route
//! registration + frame-protocol seam** so #687 can drop the real agent runtime
//! in *without* touching [`crate::build_router`]'s merge chain.
//!
//! **NO real agent streaming lives here.** The handler completes the WebSocket
//! handshake and emits a single no-op `chunk` frame followed by a `done` frame,
//! then closes. #687 replaces [`stub_agent_stream`] with a real agent runtime.
//!
//! # Wire contract (the frame protocol #687 must preserve)
//!
//! The client (`WsChatController`) and server exchange newline-free JSON text
//! frames. Inbound (client → server):
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
//! The controller ignores any frame whose `type` is none of the above, so the
//! stub's behaviour (emit one `chunk` then `done` immediately on connect) is a
//! safe no-op end-to-end: the frame contract is exercised without a real agent.
//!
//! # Where the real agent runtime plugs in (for #687)
//!
//! [`studio_ws`] is the upgrade handler; after the handshake it calls
//! [`stub_agent_stream`], which is the single seam #687 replaces. The open
//! questions #687 resolves (and which this scout deliberately leaves open):
//!
//! - **Runtime source:** does sf-serve own the agent runtime in-process, or does
//!   it delegate to the `superfield` CLI (as the legacy `POST /studio/chat` SSE
//!   path in [`super::studio`] does)? `stub_agent_stream` takes only the
//!   [`axum::extract::ws::WebSocket`] today so either choice fits.
//! - **Per-turn loop:** the stub emits one frame pair on connect and closes;
//!   #687 reads inbound `turn`/`steer` frames in a loop and streams a frame pair
//!   per turn.
//! - **Auth/session context:** this route is auth-wrapped by
//!   [`crate::build_router`] (the [`sf_auth::AuthContext`] extension is present),
//!   matching the SSE studio routes; #687 reads it to scope the agent session.
//!
//! # `POST /studio/chat` fallback
//!
//! [`studio_chat`] is a no-op JSON fallback for the non-WS chat path the legacy
//! [`ChatController`] POSTs to. The real `/studio/chat` SSE handler lives in
//! [`super::studio`]; this stub registers the path **only if** [`super::studio`]
//! does not, to avoid a route collision. Today [`super::studio`] owns
//! `/studio/chat`, so this module registers **only** `WS /studio/ws` and the
//! fallback is documented but not registered (see [`router`]).
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
//! - Issue #695 (this scout), #687 (downstream agent-stream feature).

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::Response,
    routing::any,
    Router,
};
use serde_json::json;

use crate::state::AppState;

/// `WS /studio/ws` — agent-chat WebSocket upgrade handler.
///
/// Completes the WebSocket handshake (`101 Switching Protocols`) and hands the
/// socket to [`stub_agent_stream`]. **dev-scout stub:** no real agent runtime —
/// the seam #687 replaces is [`stub_agent_stream`].
pub async fn studio_ws(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(stub_agent_stream)
}

/// No-op agent-stream emitter — **the single seam issue #687 replaces.**
///
/// Emits one `{"type":"chunk","text":"…"}` frame followed by one
/// `{"type":"done"}` frame to exercise the `WsChatController` frame contract
/// end-to-end, then closes the socket. There is **no** real agent here and no
/// per-turn read loop; #687 swaps this body for a real runtime that reads
/// inbound `turn`/`steer` frames and streams a frame pair per turn.
async fn stub_agent_stream(mut socket: WebSocket) {
    // A single no-op chunk so the controller appends *something* to the
    // pending assistant message, proving the `chunk` path is wired.
    let chunk = json!({
        "type": "chunk",
        "text": "",
    });
    if socket
        .send(Message::Text(chunk.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    // `done` marks the turn complete so the controller returns to `idle`.
    let done = json!({ "type": "done" });
    let _ = socket.send(Message::Text(done.to_string().into())).await;

    // Close the socket cleanly; #687 keeps it open for a per-turn loop instead.
    let _ = socket.send(Message::Close(None)).await;
}

/// `POST /studio/chat` — non-WS chat fallback (documented, **not registered**).
///
/// The legacy [`ChatController`] POSTs to `/studio/chat` for a non-WS path. The
/// real SSE handler for that path is owned by [`super::studio`]; this stub does
/// not register it (doing so would collide on [`crate::build_router`]'s merge
/// chain — the `additive_route_seam` test guards that). Kept here as a documented
/// placeholder so #687 has a single home for the agent-chat surface if the path
/// is ever moved off [`super::studio`].
#[allow(dead_code)]
async fn studio_chat() -> axum::Json<serde_json::Value> {
    axum::Json(json!({ "reply": "" }))
}

/// Build the studio agent-chat WebSocket router.
///
/// Registers **only** `WS /studio/ws` — a fresh path owned solely by this
/// module. `/studio/chat` is owned by [`super::studio`] (see [`studio_chat`]),
/// so it is intentionally not registered here to keep the additive-merge
/// contract collision-free.
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

    /// A lazily-connected pool — enough to build [`AppState`]; the WS stub
    /// handler touches neither the pool nor the orchestrator state.
    fn lazy_state() -> AppState {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy("postgres://localhost/placeholder")
            .expect("lazy pool");
        let session_store = sf_auth::SessionStore::new(pool.clone(), Some(3600));
        AppState::new(pool, session_store)
    }

    /// Bind the WS router (no auth layer — the upgrade handler does not read the
    /// [`sf_auth::AuthContext`] in the stub) to a random loopback port and return
    /// the bound address. The server task runs until the test process exits.
    async fn spawn_ws_server() -> SocketAddr {
        let router = super::router(lazy_state());
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        addr
    }

    /// Send a minimal RFC 6455 WebSocket upgrade request over a raw TCP socket
    /// and return the bytes the server writes back (status line + headers, and
    /// any frames that follow in the same flush).
    ///
    /// Avoids pulling in a WebSocket client crate: the stub speaks a tiny,
    /// well-known wire format, so a hand-rolled client keeps the dev-scout's
    /// dependency surface flat.
    async fn ws_handshake(addr: SocketAddr) -> (String, Vec<u8>) {
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

        // Read until the connection is closed by the server (the stub emits its
        // two frames and closes), then split the HTTP response head from the
        // trailing WebSocket frame bytes.
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => break,
            }
        }

        let head_end = find_subsequence(&buf, b"\r\n\r\n")
            .map(|i| i + 4)
            .unwrap_or(buf.len());
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let frames = buf[head_end..].to_vec();
        (head, frames)
    }

    fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    /// Decode the unmasked, single-fragment text frames the server emits.
    ///
    /// The stub sends short text payloads (`< 126` bytes) so each frame is
    /// `[0x81, len, payload…]`. Returns the decoded payload strings in order.
    fn decode_server_text_frames(mut bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        while bytes.len() >= 2 {
            let opcode = bytes[0] & 0x0f;
            let masked = bytes[1] & 0x80 != 0;
            let len = (bytes[1] & 0x7f) as usize;
            // Server frames are never masked and stay under the 126-byte
            // extended-length boundary, so a 2-byte header is sufficient.
            if masked || len >= 126 || bytes.len() < 2 + len {
                break;
            }
            let payload = &bytes[2..2 + len];
            if opcode == 0x1 {
                out.push(String::from_utf8_lossy(payload).into_owned());
            }
            bytes = &bytes[2 + len..];
        }
        out
    }

    /// Acceptance: a WS upgrade request to `/studio/ws` completes the handshake
    /// (`101 Switching Protocols`).
    #[tokio::test]
    async fn studio_ws_upgrade_returns_101() {
        let addr = spawn_ws_server().await;
        let (head, _frames) = ws_handshake(addr).await;
        assert!(
            head.starts_with("HTTP/1.1 101"),
            "expected 101 Switching Protocols, got head:\n{head}"
        );
    }

    /// Acceptance: the stub seam emits a `{type:chunk}` frame followed by a
    /// `{type:done}` frame.
    #[tokio::test]
    async fn studio_ws_stub_emits_chunk_then_done() {
        let addr = spawn_ws_server().await;
        let (head, frames) = ws_handshake(addr).await;
        assert!(
            head.starts_with("HTTP/1.1 101"),
            "handshake failed:\n{head}"
        );

        let texts = decode_server_text_frames(&frames);
        let types: Vec<String> = texts
            .iter()
            .filter_map(|t| serde_json::from_str::<serde_json::Value>(t).ok())
            .filter_map(|v| v.get("type")?.as_str().map(str::to_owned))
            .collect();

        assert_eq!(
            types,
            vec!["chunk".to_string(), "done".to_string()],
            "expected a chunk frame then a done frame, got: {texts:?}"
        );
    }

    /// The WS seam module's `router(state)` constructor builds in isolation —
    /// guards the additive-merge signature #687 relies on.
    #[tokio::test]
    async fn ws_router_builds_in_isolation() {
        let _router = super::router(lazy_state());
    }
}
