//! Auth routes — session issue and revoke.
//!
//! These routes are **public** (no auth middleware) because they are the
//! entry point for acquiring a session token.
//!
//! | Method | Path                       | Description                          |
//! |--------|----------------------------|--------------------------------------|
//! | POST   | `/api/auth/session`        | Issue a new session token            |
//! | DELETE | `/api/auth/session/{token}` | Revoke an existing session token     |
//! | GET    | `/api/auth/health`         | Liveness probe (no auth required)    |

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::state::AppState;
use sf_auth::Role;

/// Request body for `POST /api/auth/session`.
#[derive(Debug, Deserialize)]
pub struct IssueSessionRequest {
    /// The workspace to scope the session to.
    pub workspace_id: Uuid,
    /// The user who owns the session.
    pub user_id: Uuid,
    /// The role to grant within the workspace.
    pub role: RoleInput,
}

/// String role for JSON deserialization.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleInput {
    Admin,
    Member,
    Viewer,
}

impl From<RoleInput> for Role {
    fn from(r: RoleInput) -> Role {
        match r {
            RoleInput::Admin => Role::Admin,
            RoleInput::Member => Role::Member,
            RoleInput::Viewer => Role::Viewer,
        }
    }
}

/// Response body for `POST /api/auth/session`.
#[derive(Debug, Serialize)]
pub struct SessionResponse {
    /// The session token to use in subsequent requests.
    pub token: Uuid,
    /// When the session expires.
    pub expires_at: String,
    /// The workspace this session is scoped to.
    pub workspace_id: Uuid,
    /// The user who owns this session.
    pub user_id: Uuid,
    /// The role granted within the workspace.
    pub role: String,
}

/// `GET /api/auth/health` — liveness probe.
///
/// Always returns `200 OK` with `{"status":"ok"}`.
pub async fn health() -> impl IntoResponse {
    Json(json!({"status": "ok"}))
}

/// `POST /api/auth/session` — issue a new session.
///
/// Creates a row in `auth.sessions` and returns the token.
/// No authentication is required (this is the bootstrap endpoint).
pub async fn issue_session(
    State(state): State<AppState>,
    Json(req): Json<IssueSessionRequest>,
) -> impl IntoResponse {
    let role: Role = req.role.into();
    match state
        .session_store()
        .issue(req.workspace_id, req.user_id, role.clone())
        .await
    {
        Ok(session) => {
            let resp = SessionResponse {
                token: session.token,
                expires_at: session.expires_at.to_rfc3339(),
                workspace_id: session.workspace_id,
                user_id: session.user_id,
                role: role.to_string(),
            };
            (StatusCode::CREATED, Json(json!(resp))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

/// `DELETE /api/auth/session/{token}` — revoke an existing session.
///
/// Idempotent — revokes the session if it exists and returns `204 No Content`.
pub async fn revoke_session(
    State(state): State<AppState>,
    Path(token_str): Path<String>,
) -> impl IntoResponse {
    let token = match token_str.parse::<Uuid>() {
        Ok(t) => t,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "invalid token format"})),
            )
                .into_response()
        }
    };

    match state.session_store().revoke(token).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

/// Build the public auth router (no middleware — callers must NOT wrap this in
/// the auth middleware layer).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/auth/health", get(health))
        .route("/api/auth/session", post(issue_session))
        .route("/api/auth/session/{token}", delete(revoke_session))
        .with_state(state)
}
