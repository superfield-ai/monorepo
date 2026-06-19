//! Change lifecycle read routes (`/studio/changes/*`) — requires auth.
//!
//! Exposes the read side of the Change lifecycle and validation-gate state
//! machine (issue #707). The write/transition path lives in
//! [`sf_db::transition_change`] (the validation gate); this module surfaces a
//! change and its current PRD §6 state for the control panel.
//!
//! # Implemented routes
//!
//! | Method | Path                     | Description                          |
//! |--------|--------------------------|--------------------------------------|
//! | GET    | `/studio/changes/{id}`   | Read a change and its current state  |
//!
//! The handler calls [`sf_db::acquire_workspace`] to propagate workspace
//! context for RLS before reading, mirroring the other studio routes.
//!
//! # Canonical docs
//!
//! - `docs/prd.md` §6 (Change lifecycle), US13, Constraint §9 (validation gate).
//! - `docs/architecture.md` §Change Lifecycle and Validation Gate.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Extension, Json, Router,
};
use serde_json::json;
use sf_auth::AuthContext;
use sf_db::ChangeError;
use uuid::Uuid;

use crate::state::AppState;

/// `GET /studio/changes/{id}` — read a change and its current lifecycle state.
///
/// # Responses
///
/// - `200 OK` with `{ "id", "workspace_id", "title", "state" }` for a known id.
/// - `404 Not Found` with `{"error": ...}` when no change has that id.
/// - `500 Internal Server Error` on a database error (including a missing
///   migration).
pub async fn get_change(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    if let Err(e) = sf_db::acquire_workspace(state.pool(), ctx.principal_id()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response();
    }

    match sf_db::fetch_change(state.pool(), id).await {
        Ok(change) => (
            StatusCode::OK,
            Json(json!({
                "id": change.id,
                "workspace_id": change.workspace_id,
                "title": change.title,
                "state": change.state.as_str(),
            })),
        )
            .into_response(),

        Err(ChangeError::NotFound(id)) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "change not found", "id": id})),
        )
            .into_response(),

        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("change error: {}", e)})),
        )
            .into_response(),
    }
}

/// Build the change-lifecycle router.
///
/// Routes here are wrapped in the auth middleware by [`crate::build_router`].
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/studio/changes/{id}", get(get_change))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use http::{Method, Request, StatusCode};
    use tower::ServiceExt as _;

    use crate::{build_router, ServeConfig};
    use sf_db::{connect, DbConfig};

    /// Build a test router backed by a live Postgres pool.
    ///
    /// Returns `None` if `DATABASE_URL` is not set.
    async fn make_test_router() -> Option<axum::Router> {
        let cfg = DbConfig::from_env().ok()?;
        let pool = connect(&cfg).await.ok()?;
        let serve_cfg = ServeConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            session_ttl_secs: Some(3600),
            assets_dir: None,
        };
        Some(build_router(pool, &serve_cfg))
    }

    /// Integration test: the change-read route returns the current state for a
    /// known change id.
    ///
    /// Inserts a change via [`sf_db::insert_change`], then drives the request
    /// through an authenticated session and asserts the response envelope
    /// carries the change id and its `draft` state.
    ///
    /// Acceptance criterion: change-read route returns the current state for a
    /// known change id.
    ///
    /// Skipped unless `DATABASE_URL` + `WORKSPACE_ID` are set with the sf-db
    /// migrations applied.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with sf-db migration 0004 + auth schema"]
    async fn get_change_returns_current_state() {
        let router = match make_test_router().await {
            Some(r) => r,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = connect(&cfg).await.expect("pool creation failed");
        let workspace_id: uuid::Uuid = std::env::var("WORKSPACE_ID")
            .expect("WORKSPACE_ID must be set")
            .parse()
            .expect("WORKSPACE_ID must be a UUID");

        let change_id = sf_db::insert_change(&pool, workspace_id, "Change for read-route test")
            .await
            .expect("insert_change failed");

        // Issue a session for the workspace so the protected route is reachable.
        let token = mint_session(&pool, workspace_id).await;

        let req = Request::builder()
            .method(Method::GET)
            .uri(format!("/studio/changes/{change_id}"))
            .header("X-Session-Token", token)
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "known change must return 200"
        );

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json["state"].as_str(),
            Some("draft"),
            "freshly inserted change must read back as draft, got: {json:?}"
        );
        assert_eq!(
            json["id"].as_str(),
            Some(change_id.to_string().as_str()),
            "response must echo the requested change id"
        );

        sqlx::query("DELETE FROM forge.changes WHERE id = $1")
            .bind(change_id)
            .execute(&pool)
            .await
            .ok();
    }

    /// Mint a session token for `workspace_id` directly through the session
    /// store so the integration test can reach the protected route.
    async fn mint_session(pool: &sqlx::PgPool, workspace_id: uuid::Uuid) -> String {
        let store = sf_auth::SessionStore::new(pool.clone(), Some(3600));
        store
            .issue(workspace_id, workspace_id, sf_auth::Role::Owner)
            .await
            .expect("issue session failed")
            .token
            .to_string()
    }
}
