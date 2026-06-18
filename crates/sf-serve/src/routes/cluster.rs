//! Cluster-status SSE route (`/studio/cluster/events`) — requires auth.
//!
//! This module backs the control-panel **live preview**: the
//! `ClusterStatusController` (`packages/control/apps/src/controllers/
//! ClusterStatusController.ts`) opens an `EventSource` on
//! `GET /studio/cluster/events` and the `IframePanel` keys its reload off the
//! cluster-status transitions streamed here. On a `restarting → healthy`
//! transition the panel clears its "Reloading — cluster is restarting…" overlay
//! and reloads the embedded app so the developer sees the rebuilt preview.
//!
//! # Wire contract
//!
//! Each transition is emitted as one **named** SSE event:
//!
//! ```text
//!   event: cluster-status
//!   data: {"status":"healthy","workspace_id":"…"}
//! ```
//!
//! The controller subscribes specifically to the `cluster-status` event name
//! and parses the lowercase `status` token (`healthy`/`restarting`/`degraded`/
//! `unknown`) out of the JSON payload. We stamp `workspace_id` from the request
//! [`AuthContext`] extension (as the other studio routes do) so the event is
//! attributable to the authenticated workspace, never trusted from the body.
//!
//! # Where the transitions come from
//!
//! The stream is driven by the shared
//! [`OrchestratorState`](crate::orchestrator_state::OrchestratorState) carried
//! in [`AppState`]: the daemon / deploy path calls
//! [`set_cluster_status`](crate::orchestrator_state::OrchestratorState::set_cluster_status)
//! when the appliance preview's health changes, which broadcasts the new value
//! to every open `/studio/cluster/events` subscriber. The first event each
//! subscriber receives is the **current** status (a snapshot), so a client that
//! connects after the cluster is already healthy is not left at `unknown`.
//!
//! # Additive-merge contract (issue #677)
//!
//! This is its own route module so it registers without colliding on
//! [`crate::build_router`]'s merge chain (the `additive_route_seam` test panics
//! at build on any axum route collision). It is `.merge(...)`d once into the
//! protected (auth-wrapped) group.
//!
//! # Canonical docs
//!
//! - `code-reviews/product-progress-2026-06-17T180613.md` §0.1 Surfaces.
//! - `docs/architecture.md` §Control Webapp.
//! - Issue #675 (this route), #674 (the shared `OrchestratorState`).

use std::convert::Infallible;

use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Extension, Router,
};
use futures::stream::Stream;
use serde_json::json;
use sf_auth::AuthContext;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt as _;

use crate::orchestrator_state::ClusterStatus;
use crate::state::AppState;

/// The SSE event name the control-panel `ClusterStatusController` subscribes to.
const CLUSTER_EVENT: &str = "cluster-status";

/// Build a `cluster-status` SSE event for one [`ClusterStatus`], stamping the
/// authenticated `workspace_id` into the payload.
fn cluster_event(status: ClusterStatus, workspace_id: &str) -> Event {
    let data = json!({
        "status": status.as_str(),
        "workspace_id": workspace_id,
    });
    Event::default().event(CLUSTER_EVENT).data(data.to_string())
}

/// `GET /studio/cluster/events` — SSE stream of cluster-status transitions.
///
/// The first event is the current cluster status (a snapshot); subsequent
/// events are real transitions broadcast from
/// [`OrchestratorState::set_cluster_status`](crate::orchestrator_state::OrchestratorState::set_cluster_status).
/// Lagged subscribers skip dropped transitions rather than ending the stream.
pub async fn events(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let orch = state.orchestrator();
    let workspace_id = ctx.workspace_id.to_string();

    // Snapshot first so a late subscriber learns the current status without
    // waiting for the next transition.
    let snapshot = orch.cluster_status();
    let rx = orch.subscribe_cluster();

    let ws_snapshot = workspace_id.clone();
    let initial =
        futures::stream::once(
            async move { Ok::<_, Infallible>(cluster_event(snapshot, &ws_snapshot)) },
        );

    let transitions = BroadcastStream::new(rx).filter_map(move |res| match res {
        Ok(status) => Some(Ok(cluster_event(status, &workspace_id))),
        // Lagged: the subscriber fell behind; skip silently.
        Err(_) => None,
    });

    let stream = initial.chain(transitions);
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Build the cluster-status router.
///
/// All routes here are wrapped in the auth middleware by the caller
/// ([`crate::build_router`]).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/studio/cluster/events", get(events))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::Extension;
    use http::{Request, StatusCode};
    use sf_auth::{AuthContext, Role};
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt as _;
    use uuid::Uuid;

    use crate::orchestrator_state::ClusterStatus;
    use crate::state::AppState;

    /// A lazily-connected pool — enough to build [`AppState`]; the cluster
    /// handler touches the orchestrator state only, never the pool.
    fn lazy_state() -> AppState {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy("postgres://localhost/placeholder")
            .expect("lazy pool");
        let session_store = sf_auth::SessionStore::new(pool.clone(), Some(3600));
        AppState::new(pool, session_store)
    }

    fn router_with(state: AppState) -> axum::Router {
        let ext = Extension(AuthContext::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Role::Admin,
        ));
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

    /// A reader that pulls SSE frames off an axum response body on demand,
    /// buffering bytes until a complete frame (terminated by a blank line) is
    /// available. Avoids `to_bytes`, which would never return on an open stream.
    struct FrameReader<S> {
        stream: std::pin::Pin<Box<S>>,
        buf: String,
    }

    impl<E, S> FrameReader<S>
    where
        S: futures::Stream<Item = Result<axum::body::Bytes, E>>,
    {
        fn new(stream: S) -> Self {
            Self {
                stream: Box::pin(stream),
                buf: String::new(),
            }
        }

        /// Return the next complete SSE frame (text up to and including the
        /// blank-line terminator).
        async fn next_frame(&mut self) -> String {
            use futures::StreamExt as _;
            loop {
                if let Some(idx) = self.buf.find("\n\n") {
                    let frame: String = self.buf.drain(..idx + 2).collect();
                    return frame;
                }
                match self.stream.next().await {
                    Some(Ok(chunk)) => self.buf.push_str(&String::from_utf8_lossy(&chunk)),
                    _ => return std::mem::take(&mut self.buf),
                }
            }
        }
    }

    /// `GET /studio/cluster/events` is an SSE stream (acceptance: SSE test).
    #[tokio::test]
    async fn cluster_events_is_event_stream() {
        let state = lazy_state();
        let resp = router_with(state)
            .oneshot(
                Request::builder()
                    .uri("/studio/cluster/events")
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

    /// The stream's first event is a `cluster-status` event carrying the
    /// current status snapshot, so a late subscriber is not stuck at `unknown`.
    #[tokio::test]
    async fn cluster_events_emits_current_snapshot_first() {
        let state = lazy_state();
        state
            .orchestrator()
            .set_cluster_status(ClusterStatus::Healthy);

        let resp = router_with(state)
            .oneshot(
                Request::builder()
                    .uri("/studio/cluster/events")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Read just the first SSE frame off the body.
        let mut reader = FrameReader::new(resp.into_body().into_data_stream());
        let frame = reader.next_frame().await;
        assert!(
            frame.contains("event:cluster-status") || frame.contains("event: cluster-status"),
            "first frame must be a cluster-status event, got: {frame}"
        );
        assert!(
            frame.contains("\"status\":\"healthy\""),
            "snapshot must carry the current status, got: {frame}"
        );
    }

    /// A `restarting → healthy` transition pushed after connect is delivered as
    /// distinct ordered events — the reload trigger the IframePanel keys off.
    #[tokio::test]
    async fn cluster_events_streams_restart_to_healthy_transition() {
        let state = lazy_state();
        let resp = router_with(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/studio/cluster/events")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let mut reader = FrameReader::new(resp.into_body().into_data_stream());

        // First frame is the initial snapshot (unknown).
        let _snapshot = reader.next_frame().await;

        // Push a restart then a return-to-healthy.
        state
            .orchestrator()
            .set_cluster_status(ClusterStatus::Restarting);
        let restart = reader.next_frame().await;
        assert!(
            restart.contains("\"status\":\"restarting\""),
            "expected restarting frame, got: {restart}"
        );

        state
            .orchestrator()
            .set_cluster_status(ClusterStatus::Healthy);
        let healthy = reader.next_frame().await;
        assert!(
            healthy.contains("\"status\":\"healthy\""),
            "expected healthy frame, got: {healthy}"
        );
    }
}
