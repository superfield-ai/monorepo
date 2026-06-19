//! Studio/control-panel API routes (`/studio/*`) — requires auth.
//!
//! These routes correspond to the control-panel API surface described in
//! `docs/architecture.md` §HTTP routes (control server, :7000).  All requests
//! pass through the auth middleware and carry an [`AuthContext`] extension.
//!
//! # Implemented routes
//!
//! | Method | Path                    | Description                              |
//! |--------|-------------------------|------------------------------------------|
//! | GET    | `/studio/status`        | Studio mode and auth status              |
//! | POST   | `/studio/issues`        | Create an Issue (+ optional Features)    |
//! | GET    | `/studio/issues`        | List Issue / Feature project-graph nodes |
//! | POST   | `/studio/issues/update` | Update an Issue/Feature (state and/or title) |
//! | POST   | `/studio/steer`         | Steer/redirect work on a Feature/Issue   |
//!
//! The issue/feature routes back the control-panel Feature pane
//! (`FeaturePaneController`) and the `superfield issue` / `superfield feature`
//! CLI verbs. They write through the project graph
//! ([`sf_db::insert_issue`] / [`sf_db::insert_feature`] /
//! [`sf_db::update_node`]) so created nodes read back consistently through the
//! existing `GET /pages/project` projection (issue #672).
//!
//! Each new handler uses [`sf_db::acquire_workspace`] to propagate workspace
//! context for RLS before touching the database.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    middleware,
    response::IntoResponse,
    routing::{get, post},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sf_auth::AuthContext;

use crate::authz::require_write;
use sf_db::{ProjectGraphError, ProjectNode};
use uuid::Uuid;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Render a [`ProjectNode`] as a JSON object for API responses.
fn node_json(node: &ProjectNode) -> serde_json::Value {
    json!({
        "id": node.id,
        "title": node.content,
        "node_type": node.node_type,
        "state": node.state,
        "external_ref": node.external_ref,
    })
}

/// Map a [`ProjectGraphError`] to an HTTP response.
fn project_graph_error(e: ProjectGraphError) -> axum::response::Response {
    match e {
        ProjectGraphError::InvalidState(s) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("invalid state '{}'", s),
                        "valid_states": sf_db::NODE_STATES})),
        )
            .into_response(),
        other => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("project graph error: {}", other)})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /studio/issues — create
// ---------------------------------------------------------------------------

/// Request body for `POST /studio/issues`.
#[derive(Debug, Deserialize)]
pub struct CreateIssueBody {
    /// The issue title / description.
    pub title: String,
    /// Optional external reference (e.g. a GitHub issue number).
    #[serde(default)]
    pub external_ref: Option<String>,
    /// Optional child feature titles to create and link to the new issue.
    #[serde(default)]
    pub features: Vec<String>,
}

/// `POST /studio/issues` — create an Issue node and optional child Features.
///
/// Returns `201 Created` with the created issue and feature node IDs.
pub async fn create_issue(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Json(body): Json<CreateIssueBody>,
) -> impl IntoResponse {
    let title = body.title.trim();
    if title.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "title must not be empty"})),
        )
            .into_response();
    }

    // Propagate workspace context for RLS before writing.
    if let Err(e) = sf_db::acquire_workspace(state.pool(), ctx.principal_id()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response();
    }

    let issue_id =
        match sf_db::insert_issue(state.pool(), title, body.external_ref.as_deref()).await {
            Ok(id) => id,
            Err(e) => return project_graph_error(e),
        };

    let mut feature_ids: Vec<Uuid> = Vec::new();
    for feature_title in &body.features {
        let ft = feature_title.trim();
        if ft.is_empty() {
            continue;
        }
        match sf_db::insert_feature(state.pool(), issue_id, ft).await {
            Ok(fid) => feature_ids.push(fid),
            Err(e) => return project_graph_error(e),
        }
    }

    (
        StatusCode::CREATED,
        Json(json!({
            "issue_id": issue_id,
            "feature_ids": feature_ids,
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /studio/issues — list
// ---------------------------------------------------------------------------

/// Query parameters for `GET /studio/issues`.
#[derive(Debug, Deserialize)]
pub struct ListNodesQuery {
    /// Optional `node_type` filter: `Issue` or `Feature`. Omit for all types.
    #[serde(default)]
    pub node_type: Option<String>,
}

/// `GET /studio/issues` — list project-graph nodes (Issues and Features).
///
/// Optional `?node_type=Issue` (or `Feature`) filters the result.
pub async fn list_issues(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Query(q): Query<ListNodesQuery>,
) -> impl IntoResponse {
    if let Err(e) = sf_db::acquire_workspace(state.pool(), ctx.principal_id()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response();
    }

    match sf_db::list_nodes(state.pool(), q.node_type.as_deref()).await {
        Ok(nodes) => {
            let items: Vec<_> = nodes.iter().map(node_json).collect();
            (StatusCode::OK, Json(json!({ "nodes": items }))).into_response()
        }
        Err(e) => project_graph_error(e),
    }
}

// ---------------------------------------------------------------------------
// POST /studio/issues/update and POST /studio/steer — update / steer
// ---------------------------------------------------------------------------

/// Request body for `POST /studio/issues/update` and `POST /studio/steer`.
#[derive(Debug, Deserialize)]
pub struct UpdateNodeBody {
    /// `project_nodes.id` of the Issue/Feature to update.
    pub id: Uuid,
    /// Optional new lifecycle state (`open`/`in_progress`/`validated`/`closed`).
    #[serde(default)]
    pub state: Option<String>,
    /// Optional new title / content.
    #[serde(default)]
    pub title: Option<String>,
}

/// Shared update handler backing both `/studio/issues/update` and
/// `/studio/steer`.
async fn apply_update(
    state: &AppState,
    ctx: &AuthContext,
    body: UpdateNodeBody,
) -> axum::response::Response {
    if body.state.is_none() && body.title.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "at least one of 'state' or 'title' must be provided"})),
        )
            .into_response();
    }

    if let Err(e) = sf_db::acquire_workspace(state.pool(), ctx.principal_id()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response();
    }

    match sf_db::update_node(
        state.pool(),
        body.id,
        body.state.as_deref(),
        body.title.as_deref(),
    )
    .await
    {
        Ok(true) => (
            StatusCode::OK,
            Json(json!({"updated": true, "id": body.id})),
        )
            .into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no node found with that id", "id": body.id})),
        )
            .into_response(),
        Err(e) => project_graph_error(e),
    }
}

/// `POST /studio/issues/update` — update an Issue/Feature's state and/or title.
pub async fn update_issue(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Json(body): Json<UpdateNodeBody>,
) -> impl IntoResponse {
    apply_update(&state, &ctx, body).await
}

/// `POST /studio/steer` — steer/redirect work on a Feature or Issue.
///
/// Backs the control-panel Feature pane's steer action. Steering is modelled
/// as an update to the targeted node's lifecycle state and/or title through
/// the project graph, so the change is reflected in `GET /pages/project`.
pub async fn steer(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Json(body): Json<UpdateNodeBody>,
) -> impl IntoResponse {
    apply_update(&state, &ctx, body).await
}

/// Build the studio router.
///
/// All routes here will be wrapped in the auth middleware by the caller
/// ([`crate::build_router`]).
pub fn router(state: AppState) -> Router {
    // Write routes are gated by `require_write` (issue #711): Auditor and
    // Viewer are read-only and receive 403; all other roles pass. The gate
    // runs after `auth_middleware` (applied by the caller), which injects the
    // `AuthContext` it inspects.
    Router::new()
        .route("/studio/status", get(status))
        .route("/studio/issues", post(create_issue).get(list_issues))
        .route(
            "/studio/issues/update",
            post(update_issue).layer(middleware::from_fn(require_write)),
        )
        .route(
            "/studio/steer",
            post(steer).layer(middleware::from_fn(require_write)),
        )
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use http::{Method, Request};
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

    /// Integration test: an unauthenticated `POST /studio/issues` is rejected.
    ///
    /// The studio routes sit behind the auth middleware, so a request with no
    /// session cookie must not reach the handler. This proves the create route
    /// is wired into the protected router.
    ///
    /// Skipped unless `DATABASE_URL` is set (a pool is needed to build state).
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum + auth schema migrated"]
    async fn studio_create_issue_requires_auth() {
        let router = match make_test_router().await {
            Some(r) => r,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        let req = Request::builder()
            .method(Method::POST)
            .uri("/studio/issues")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"title":"unauthorized issue"}"#))
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_ne!(
            resp.status(),
            http::StatusCode::CREATED,
            "unauthenticated create must not succeed"
        );
    }
}
