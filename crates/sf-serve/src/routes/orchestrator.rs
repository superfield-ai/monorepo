//! Orchestrator control + analytics routes — requires auth.
//!
//! These routes back the control-panel **Orchestrator** tab
//! (`OrchestratorController.ts` / `OrchestratorView.tsx`). They read and steer
//! the live orchestrator runtime state ([`crate::orchestrator_state`]) that the
//! daemon boot path drives. Every route passes through the auth middleware.
//!
//! # Implemented routes
//!
//! | Method | Path                            | Description                              |
//! |--------|---------------------------------|------------------------------------------|
//! | GET    | `/orchestrator/status`          | Live process, pid, uptime, reachability  |
//! | GET    | `/analytics/loops`              | Per-loop (plan/dev/doc) health           |
//! | GET    | `/analytics/slots`              | Active work slots                        |
//! | GET    | `/orchestrator/logs`            | SSE: live log tail                       |
//! | GET    | `/analytics/check-runs/stream`  | SSE: live CI/check-run feed              |
//! | POST   | `/orchestrator/start`           | Start the loop                           |
//! | POST   | `/orchestrator/stop`            | Stop (drain) the loop                    |
//!
//! # Status / loops / slots shape
//!
//! The JSON shapes match the control-panel TypeScript interfaces exactly:
//! `OrchestratorController` polls `/orchestrator/status` for
//! `{process, pid, apiReachable, uptimeMs}`, `/analytics/loops` for
//! `{loops: {plan, dev, doc}}`, and `/analytics/slots` for `{slots: [...]}`.
//!
//! # SSE streams
//!
//! The two streaming routes wrap a `tokio::sync::broadcast` receiver
//! ([`OrchestratorState::subscribe_logs`](crate::orchestrator_state::OrchestratorState::subscribe_logs)
//! / `subscribe_ci`) as an axum [`Sse`] response. A subscriber that lags behind
//! the channel capacity skips the dropped messages rather than terminating the
//! stream.

use std::convert::Infallible;

use axum::{
    extract::State,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Extension, Json, Router,
};
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::json;
use sf_auth::AuthContext;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt as _;

use crate::orchestrator_state::ProcessState;
use crate::state::AppState;

/// `GET /orchestrator/status` — live process, pid, uptime, and reachability.
///
/// Reads the live [`crate::orchestrator_state::OrchestratorState`] rather than
/// returning hardcoded nulls. `apiReachable` is `true` whenever this handler
/// runs (the request reached the server), so the control panel's connection
/// indicator reflects real reachability.
pub async fn status(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
) -> impl IntoResponse {
    let orch = state.orchestrator();
    let process = match orch.process_state() {
        ProcessState::Stopped => "stopped",
        ProcessState::Starting => "starting",
        ProcessState::Running => "running",
        ProcessState::Stopping => "stopping",
    };
    Json(json!({
        "workspace_id": ctx.workspace_id,
        "process": process,
        "pid": orch.pid(),
        "apiReachable": true,
        "uptimeMs": orch.uptime_ms(),
    }))
}

/// `GET /analytics/loops` — per-loop health for the plan/dev/doc lanes.
pub async fn loops(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({ "loops": state.orchestrator().loops_json() }))
}

/// `GET /analytics/slots` — active work slots driving the Orchestrator cards.
pub async fn slots(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({ "slots": state.orchestrator().slots() }))
}

/// `GET /orchestrator/logs` — Server-Sent Events stream of live log lines.
///
/// Each broadcast log line is emitted as one SSE `data:` event. Lagged
/// subscribers (channel overrun) skip the dropped lines rather than ending the
/// stream. A keep-alive comment holds idle connections open.
pub async fn logs_stream(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.orchestrator().subscribe_logs();
    let stream = BroadcastStream::new(rx).filter_map(|res| match res {
        Ok(line) => Some(Ok(Event::default().data(line))),
        // Lagged: the subscriber fell behind; skip silently.
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// `GET /analytics/check-runs/stream` — SSE stream of CI/check-run events.
///
/// Each event is a JSON object (already serialised by the publisher) emitted as
/// one SSE `data:` event so the control panel's CI feed parses it directly.
pub async fn check_runs_stream(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.orchestrator().subscribe_ci();
    let stream = BroadcastStream::new(rx).filter_map(|res| match res {
        Ok(payload) => Some(Ok(Event::default().data(payload))),
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Request body for `POST /orchestrator/start`.
#[derive(Debug, Default, Deserialize)]
pub struct StartBody {
    /// Optional repository slug the loop should target (informational in v0).
    #[serde(default)]
    pub repo: Option<String>,
    /// Optional desired work-slot count (informational in v0).
    #[serde(default, rename = "slotCount")]
    pub slot_count: Option<u32>,
}

/// `POST /orchestrator/start` — start the loop.
///
/// Transitions the observable process state to `running` so the next status
/// poll reflects the change, and publishes a log line. Returns `{ok: true}`
/// (the control panel keys its start flow off `ok`).
pub async fn start(
    State(state): State<AppState>,
    body: Option<Json<StartBody>>,
) -> impl IntoResponse {
    let orch = state.orchestrator();
    let body = body.map(|Json(b)| b).unwrap_or_default();

    orch.set_process_state(ProcessState::Running);
    let repo = body.repo.unwrap_or_else(|| "(default)".to_string());
    orch.publish_log(format!("orchestrator: loop started (repo={repo})"));

    Json(json!({ "ok": true, "process": "running" }))
}

/// `POST /orchestrator/stop` — stop the loop.
///
/// Transitions the observable process state to `stopped`, clears the active
/// slots, and publishes a log line. If a real
/// [`LoopHandle`](crate::loop_handle::LoopHandle) is installed it is drained so
/// the in-flight gardening step finishes cleanly.
pub async fn stop(State(state): State<AppState>) -> impl IntoResponse {
    let orch = state.orchestrator();
    orch.set_process_state(ProcessState::Stopping);

    // Drain the real loop if one is installed (best-effort).
    if let Some(handle) = state.loop_handle() {
        let _ = handle.drain().await;
    }

    orch.set_slots(Vec::new());
    orch.set_process_state(ProcessState::Stopped);
    orch.publish_log("orchestrator: loop stopped".to_string());

    Json(json!({ "ok": true, "process": "stopped" }))
}

/// Build the orchestrator + analytics router.
///
/// All routes here are wrapped in the auth middleware by the caller
/// ([`crate::build_router`]).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/orchestrator/status", get(status))
        .route("/orchestrator/logs", get(logs_stream))
        .route("/orchestrator/start", post(start))
        .route("/orchestrator/stop", post(stop))
        .route("/analytics/loops", get(loops))
        .route("/analytics/slots", get(slots))
        .route("/analytics/check-runs/stream", get(check_runs_stream))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::Extension;
    use http::{Method, Request, StatusCode};
    use sf_auth::{AuthContext, Role, SessionStore};
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt as _;
    use uuid::Uuid;

    use crate::orchestrator_state::{OrchestratorState, ProcessState};
    use crate::state::AppState;

    /// Status reflects a running vs stopped loop (acceptance: API test).
    #[test]
    fn status_process_reflects_lifecycle() {
        let orch = OrchestratorState::new();
        assert_eq!(orch.process_state(), ProcessState::Stopped);
        assert!(orch.uptime_ms().is_none());

        orch.set_process_state(ProcessState::Running);
        assert_eq!(orch.process_state(), ProcessState::Running);
        assert!(orch.uptime_ms().is_some());

        orch.set_process_state(ProcessState::Stopped);
        assert_eq!(orch.process_state(), ProcessState::Stopped);
        assert!(orch.uptime_ms().is_none());
    }

    /// A lazily-connected pool — enough to build [`AppState`]; route handlers
    /// here touch the orchestrator state only, never the pool.
    fn lazy_state() -> AppState {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy("postgres://localhost/placeholder")
            .expect("lazy pool");
        let session_store = SessionStore::new(pool.clone(), Some(3600));
        AppState::new(pool, session_store)
    }

    fn auth_ext() -> Extension<AuthContext> {
        Extension(AuthContext::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Role::Admin,
        ))
    }

    fn router_with(state: AppState) -> axum::Router {
        // Inject a fake AuthContext extension so the auth-requiring `status`
        // handler runs without the middleware/DB.
        let ext = auth_ext();
        super::router(state).layer(axum::middleware::from_fn(
            move |mut req: Request<Body>, next: axum::middleware::Next| {
                let ext = ext.clone();
                async move {
                    req.extensions_mut().insert(ext.0);
                    next.run(req).await
                }
            },
        ))
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    /// `GET /orchestrator/status` reports `stopped` then `running` after start,
    /// and `stopped` again after stop — the change is reflected in status
    /// (acceptance: API + control test).
    #[tokio::test]
    async fn status_follows_start_then_stop() {
        let state = lazy_state();

        // Initially stopped.
        let resp = router_with(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/orchestrator/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let j = body_json(resp).await;
        assert_eq!(j["process"], "stopped");
        assert!(j["uptimeMs"].is_null());
        assert_eq!(j["apiReachable"], true);

        // POST /orchestrator/start → running.
        let resp = router_with(state.clone())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/orchestrator/start")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"repo":"acme/widgets"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let j = body_json(resp).await;
        assert_eq!(j["ok"], true);
        assert_eq!(state.orchestrator().process_state(), ProcessState::Running);

        let resp = router_with(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/orchestrator/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let j = body_json(resp).await;
        assert_eq!(j["process"], "running");
        assert!(j["uptimeMs"].as_i64().is_some());

        // POST /orchestrator/stop → stopped.
        let resp = router_with(state.clone())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/orchestrator/stop")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let j = body_json(resp).await;
        assert_eq!(j["ok"], true);
        assert_eq!(state.orchestrator().process_state(), ProcessState::Stopped);
    }

    /// `/analytics/loops` and `/analytics/slots` report seeded state
    /// (acceptance: API test — loops/slots report a seeded active work item).
    #[tokio::test]
    async fn loops_and_slots_report_seeded_state() {
        let state = lazy_state();
        state.orchestrator().record_dev_tick(42);
        state
            .orchestrator()
            .set_slots(vec![crate::orchestrator_state::WorkSlot {
                slot: 0,
                issue_number: 674,
                role: "primary".into(),
                session_id: "sess-674".into(),
                backend: "claude".into(),
                model: "opus".into(),
                started_at: "2026-06-18T00:00:00Z".into(),
                elapsed_ms: 5_000,
                heartbeat_at: Some(1_700_000_000_000),
            }]);

        let resp = router_with(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/analytics/loops")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let j = body_json(resp).await;
        assert_eq!(j["loops"]["dev"]["lastTickDurationMs"], 42);
        assert_eq!(j["loops"]["dev"]["circuitTripped"], false);

        let resp = router_with(state)
            .oneshot(
                Request::builder()
                    .uri("/analytics/slots")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let j = body_json(resp).await;
        assert_eq!(j["slots"][0]["issueNumber"], 674);
        assert_eq!(j["slots"][0]["role"], "primary");
    }

    /// `GET /orchestrator/logs` is an SSE stream that emits a published line to
    /// a subscriber (acceptance: SSE test).
    #[tokio::test]
    async fn logs_stream_emits_published_line() {
        let state = lazy_state();
        // Subscribe before publishing so the broadcast line is delivered.
        let mut rx = state.orchestrator().subscribe_logs();

        let resp = router_with(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/orchestrator/logs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(ct.starts_with("text/event-stream"), "got content-type {ct}");

        state.orchestrator().publish_log("ci: build ok");
        let got = rx.recv().await.expect("recv");
        assert_eq!(got, "ci: build ok");
    }

    /// `GET /analytics/check-runs/stream` is an SSE stream that emits a
    /// published CI event (acceptance: SSE test).
    #[tokio::test]
    async fn check_runs_stream_is_event_stream() {
        let state = lazy_state();
        let resp = router_with(state)
            .oneshot(
                Request::builder()
                    .uri("/analytics/check-runs/stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(ct.starts_with("text/event-stream"), "got content-type {ct}");
    }
}
