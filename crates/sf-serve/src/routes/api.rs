//! App API routes (`/api/*`) — workspace-scoped, requires auth.
//!
//! All handlers in this module receive an [`AuthContext`] extension from the
//! auth middleware.  They must use [`sf_db::acquire_workspace`] with
//! `ctx.principal_id()` to obtain workspace-context-aware database connections
//! so that per-schema RLS policies fire correctly.
//!
//! | Method | Path           | Description                                    |
//! |--------|----------------|------------------------------------------------|
//! | GET    | `/api/status`  | Authenticated status probe                     |
//! | GET    | `/api/me`      | Return the current principal's auth context    |
//!
//! Additional app-specific endpoints will be added as the app surface is
//! ported to Rust.  These two routes establish the auth/RLS pipeline and the
//! workspace-propagation pattern used by all future handlers.

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Extension, Json, Router,
};
use serde_json::json;
use sf_auth::AuthContext;

use crate::state::AppState;

/// `GET /api/status` — liveness probe that requires authentication.
///
/// Returns `200 OK` with the current workspace and user IDs to confirm that
/// auth is working end-to-end.
pub async fn status(
    Extension(ctx): Extension<AuthContext>,
) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "workspace_id": ctx.workspace_id,
        "user_id": ctx.user_id,
        "role": ctx.role.to_string(),
    }))
}

/// `GET /api/me` — return the current principal's identity.
///
/// Demonstrates workspace context propagation: acquires a DB connection with
/// the principal context set and runs a lightweight SELECT to confirm the
/// `app.current_principal_id` session variable is correct.
pub async fn me(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
) -> impl IntoResponse {
    // Acquire a workspace-scoped connection.  The SET LOCAL applies the
    // principal_id so that RLS policies on every schema can reference
    // current_setting('app.current_principal_id').
    match sf_db::acquire_workspace(state.pool(), ctx.principal_id()).await {
        Ok(mut conn) => {
            // Verify the session variable was applied correctly.
            let row: Result<(String,), _> =
                sqlx::query_as("SELECT current_setting('app.current_principal_id', true)")
                    .fetch_one(&mut *conn)
                    .await;

            let stored_principal = match row {
                Ok((s,)) => s,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"error": format!("db error: {}", e)})),
                    )
                        .into_response()
                }
            };

            Json(json!({
                "workspace_id": ctx.workspace_id,
                "user_id": ctx.user_id,
                "role": ctx.role.to_string(),
                "principal_id": ctx.principal_id(),
                "db_principal_id": stored_principal,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response(),
    }
}

/// Build the app API router.
///
/// All routes here will be wrapped in the auth middleware by the caller
/// ([`crate::build_router`]).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/status", get(status))
        .route("/api/me", get(me))
        .with_state(state)
}
