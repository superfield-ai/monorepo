//! Auth routes — session issue and revoke.
//!
//! These routes are **public** (no auth middleware) because they are the
//! entry point for acquiring a session token.
//!
//! | Method | Path                         | Description                          |
//! |--------|------------------------------|--------------------------------------|
//! | POST   | `/api/auth/session`          | Issue a new session token            |
//! | DELETE | `/api/auth/session/{token}`  | Revoke an existing session token     |
//! | GET    | `/api/auth/health`           | Liveness probe (no auth required)    |
//! | POST   | `/api/auth/register`         | Register a user (dev/E2E bootstrap)  |

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
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

/// Request body for `POST /api/auth/register`.
///
/// Dev / E2E bootstrap registration.  The username and password are accepted
/// for compatibility with the E2E test suite; no password hashing or
/// per-username uniqueness enforcement is performed — a fresh workspace and
/// user UUID are minted on every call.
#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    /// Chosen display username.
    pub username: String,
    /// Password (accepted but not stored — auth uses session tokens).
    #[allow(dead_code)]
    pub password: String,
}

/// Response body for `POST /api/auth/register`.
#[derive(Debug, Serialize)]
pub struct RegisterResponse {
    /// Opaque user identifier in the form `user_<uuid>`.
    pub id: String,
    /// The username that was registered.
    pub username: String,
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

/// `POST /api/auth/register` — dev / E2E bootstrap user registration.
///
/// Mints a fresh workspace UUID and user UUID, issues a session token scoped
/// to that workspace, and returns the user info with the session token in a
/// `superfield_auth` cookie.
///
/// This endpoint is intentionally simple and stateless from the business-logic
/// perspective: username and password are accepted for E2E-test compatibility
/// but no password hashing or per-username uniqueness checks are performed.
/// Each call produces a new, independent workspace + user identity.
///
/// The `superfield_auth` cookie value is the raw session token UUID.  The
/// auth middleware (`crate::auth`) accepts this cookie (in addition to the
/// `X-Session-Token` header and the `session` cookie) so authenticated page
/// loads work after registration.
pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> impl IntoResponse {
    if req.username.trim().is_empty() || req.password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "username and password required"})),
        )
            .into_response();
    }

    // Mint fresh UUIDs for the new workspace and user.
    let workspace_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();

    match state
        .session_store()
        .issue(workspace_id, user_id, Role::Admin)
        .await
    {
        Ok(session) => {
            let resp = RegisterResponse {
                id: format!("user_{}", user_id),
                username: req.username,
            };

            // Encode the session token in the `superfield_auth` cookie.
            // HttpOnly + SameSite=Lax mirrors what the Bun backend sent so
            // existing E2E helpers can parse the cookie without changes.
            let cookie = format!(
                "superfield_auth={}; Path=/; HttpOnly; SameSite=Lax",
                session.token
            );

            (
                StatusCode::CREATED,
                [(header::SET_COOKIE, cookie)],
                Json(json!(resp)),
            )
                .into_response()
        }
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
        .route("/api/auth/register", post(register))
        .with_state(state)
}
