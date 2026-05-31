//! Studio/control-panel API routes (`/studio/*`) — requires auth.
//!
//! These routes correspond to the control-panel API surface described in
//! `docs/architecture.md` §HTTP routes (control server, :7000).  All requests
//! pass through the auth middleware and carry an [`AuthContext`] extension.
//!
//! # Implemented routes
//!
//! | Method | Path             | Description                          |
//! |--------|------------------|--------------------------------------|
//! | GET    | `/studio/status` | Studio mode and auth status          |
//!
//! Additional routes (commits, timeline, rollback, chat, etc.) will be
//! implemented as the TypeScript control server is progressively retired.
//! Each new handler must use [`sf_db::acquire_workspace`] to propagate
//! workspace context for RLS.

use axum::{response::IntoResponse, routing::get, Extension, Json, Router};
use serde_json::json;
use sf_auth::AuthContext;

use crate::state::AppState;

/// `GET /studio/status` — studio mode and auth check.
///
/// Returns the authenticated principal's workspace and role so the browser
/// UI can confirm the Rust backend is reachable and auth is active.
pub async fn status(Extension(ctx): Extension<AuthContext>) -> impl IntoResponse {
    Json(json!({
        "studio": true,
        "workspace_id": ctx.workspace_id,
        "user_id": ctx.user_id,
        "role": ctx.role.to_string(),
    }))
}

/// Build the studio router.
///
/// All routes here will be wrapped in the auth middleware by the caller
/// ([`crate::build_router`]).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/studio/status", get(status))
        .with_state(state)
}
