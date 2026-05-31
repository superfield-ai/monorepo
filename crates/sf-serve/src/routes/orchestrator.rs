//! Orchestrator control routes (`/orchestrator/*`) — requires auth.
//!
//! These routes correspond to the orchestrator endpoints described in
//! `docs/architecture.md` §HTTP routes (control server, :7000).  All requests
//! pass through the auth middleware.
//!
//! # Implemented routes
//!
//! | Method | Path                    | Description                                |
//! |--------|-------------------------|--------------------------------------------|
//! | GET    | `/orchestrator/status`  | Process, PID, and API reachability         |
//!
//! Additional routes (start/stop, logs SSE) will be added as the TypeScript
//! orchestrator is progressively retired.

use axum::{
    response::IntoResponse,
    routing::get,
    Extension, Json, Router,
};
use serde_json::json;
use sf_auth::AuthContext;

use crate::state::AppState;

/// `GET /orchestrator/status` — process and API reachability check.
///
/// Returns a minimal status object.  The full implementation will include
/// PID, uptime, and API reachability once the process manager is ported.
pub async fn status(
    Extension(ctx): Extension<AuthContext>,
) -> impl IntoResponse {
    Json(json!({
        "workspace_id": ctx.workspace_id,
        "process": "unknown",
        "pid": null,
        "apiReachable": false,
        "uptimeMs": null,
    }))
}

/// Build the orchestrator router.
///
/// All routes here will be wrapped in the auth middleware by the caller
/// ([`crate::build_router`]).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/orchestrator/status", get(status))
        .with_state(state)
}
