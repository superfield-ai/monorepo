//! `GET /pages/{name}` — unauthenticated page projection route.
//!
//! Serves named knowledge-base pages as plain-text markdown.  Pages are
//! read-only projections over the Nexum graph; the same query logic is used
//! by the `superfield page <name>` CLI command.
//!
//! # Route inventory
//!
//! | Method | Path               | Auth     | Description                           |
//! |--------|--------------------|----------|---------------------------------------|
//! | GET    | `/pages/project`   | None     | Render the project management graph   |
//! | GET    | `/pages/{name}`    | None     | Render a named page as markdown       |
//!
//! The `/pages/project` route is registered first (more specific) and uses
//! [`sf_db::fetch_project_page`] — a recursive CTE traversal over the project
//! node graph — rather than the `nexum.documents` document model used by the
//! other page routes.
//!
//! # Security note
//!
//! Authentication is explicitly deferred on this route (see issue #492 scope:
//! "Authentication on the /pages/ route — deferred; route is localhost-only
//! for this milestone").  The route is expected to be reachable only from
//! localhost during milestone 1.
//!
//! # Error behaviour
//!
//! - Unknown page name → `404 Not Found` with JSON `{"error": "unknown page"}`
//! - Page exists in registry but has no content yet → `404 Not Found` with
//!   JSON `{"error": "no content yet"}`
//! - Database error → `500 Internal Server Error` with JSON `{"error": ...}`
//!
//! # Canonical docs
//!
//! - Issue #492 scope.
//! - Issue #493 scope.
//! - `docs/architecture.md` §Nexum — page-revision schema and project graph.

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::json;
use sf_db::{fetch_page_content, fetch_project_page, PageQueryError};

use crate::state::AppState;

/// `GET /pages/project` — render the project management graph as markdown.
///
/// Uses [`sf_db::fetch_project_page`]: a recursive CTE traversal over
/// `nexum.project_nodes` and `nexum.links` (with `project:` edge types).
/// This is a different backing query from the document-model pages (prd,
/// architecture, plan, strategy).
///
/// # Responses
///
/// - `200 OK` with `Content-Type: text/plain; charset=utf-8` and the project
///   graph markdown in the body.
/// - `404 Not Found` with JSON `{"error": "no content yet"}` when there are
///   no Issue nodes in the project graph.
/// - `500 Internal Server Error` with JSON `{"error": "..."}` on DB errors.
pub async fn get_page_project(State(state): State<AppState>) -> impl IntoResponse {
    match fetch_project_page(state.pool()).await {
        Ok(Some(content)) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            content,
        )
            .into_response(),

        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "no content yet",
                "page": "project",
                "hint": "the project graph has no Issue nodes yet"
            })),
        )
            .into_response(),

        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("database error: {}", e)})),
        )
            .into_response(),
    }
}

/// `GET /pages/{name}` — render a named page as markdown.
///
/// # Responses
///
/// - `200 OK` with `Content-Type: text/plain; charset=utf-8` and the page
///   markdown in the body.
/// - `404 Not Found` with JSON `{"error": "unknown page 'X'"}` for
///   unrecognised names.
/// - `404 Not Found` with JSON `{"error": "no content yet"}` for known names
///   with no database content.
/// - `500 Internal Server Error` with JSON `{"error": "..."}` on DB errors.
pub async fn get_page(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    match fetch_page_content(state.pool(), &name).await {
        Ok(Some(content)) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            content,
        )
            .into_response(),

        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no content yet", "page": name})),
        )
            .into_response(),

        Err(PageQueryError::UnknownPage(n)) => (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": format!("unknown page '{}'", n),
                "known_pages": sf_db::KNOWN_PAGES,
            })),
        )
            .into_response(),

        Err(PageQueryError::Database(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("database error: {}", e)})),
        )
            .into_response(),
    }
}

/// Build the pages router.
///
/// Routes here are **not** wrapped in the auth middleware — they are
/// unauthenticated for milestone 1 (localhost-only).
///
/// The `/pages/project` route is registered first (axum resolves static
/// routes before parameterised ones, so order here does not matter for
/// correctness, but the explicit route makes the intent clear).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/pages/project", get(get_page_project))
        .route("/pages/{name}", get(get_page))
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
    use sf_db::{connect, insert_feature, insert_issue, DbConfig};

    /// Build a test router backed by a live Postgres pool.
    ///
    /// Returns `None` if `DATABASE_URL` is not set.
    async fn make_test_router() -> Option<axum::Router> {
        let cfg = DbConfig::from_env().ok()?;
        let pool = connect(&cfg).await.ok()?;
        let cfg = ServeConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            session_ttl_secs: Some(3600),
            assets_dir: None,
        };
        Some(build_router(pool, &cfg))
    }

    /// Unit test: `GET /pages/nonexistent` returns 404 with 'unknown page'.
    ///
    /// This test does NOT require a live database — the unknown-page guard
    /// fires before any SQL is executed.
    ///
    /// We still need a pool to build the state, so this is skipped without
    /// DATABASE_URL.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn get_page_unknown_name_returns_404() {
        let router = match make_test_router().await {
            Some(r) => r,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        let req = Request::builder()
            .method(Method::GET)
            .uri("/pages/nonexistent")
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "unknown page must yield 404"
        );

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(
            json["error"]
                .as_str()
                .unwrap_or("")
                .contains("unknown page"),
            "error must mention 'unknown page', got: {:?}",
            json
        );
    }

    /// Integration test: `GET /pages/prd` returns 200 with fixture content.
    ///
    /// Inserts a fixture document_version for 'prd'; GETs /pages/prd; asserts
    /// HTTP 200 and response body contains fixture content.
    ///
    /// Skipped unless `DATABASE_URL` is set with the nexum schema migrated.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum schema migrated"]
    async fn get_page_prd_returns_200() {
        let router = match make_test_router().await {
            Some(r) => r,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        // Insert fixture data.
        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = connect(&cfg).await.expect("pool creation failed");

        let corpus_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.corpora (name) VALUES ('test-page-serve') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .expect("corpus insert failed");

        let doc_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.documents (corpus_id, title) VALUES ($1, 'prd') RETURNING id",
        )
        .bind(corpus_id)
        .fetch_one(&pool)
        .await
        .expect("document insert failed");

        let ver_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.document_versions (doc_id, version_num, status) \
             VALUES ($1, 1, 'done') RETURNING id",
        )
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("version insert failed");

        let block_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type) \
             VALUES ($1, '# Fixture PRD for serve test', 'hash_fixture_prd_serve', 'heading') \
             RETURNING id",
        )
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("block insert failed");

        sqlx::query(
            "INSERT INTO nexum.version_blocks (version_id, block_id, seq) VALUES ($1, $2, 0)",
        )
        .bind(ver_id)
        .bind(block_id)
        .execute(&pool)
        .await
        .expect("version_block insert failed");

        // Request the page.
        let req = Request::builder()
            .method(Method::GET)
            .uri("/pages/prd")
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "GET /pages/prd must return 200"
        );

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body_str = String::from_utf8(body.to_vec()).unwrap();
        assert!(
            body_str.contains("Fixture PRD for serve test"),
            "body must contain fixture content, got: {:?}",
            body_str
        );

        // Cleanup.
        sqlx::query("DELETE FROM nexum.version_blocks WHERE version_id = $1")
            .bind(ver_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.document_versions WHERE id = $1")
            .bind(ver_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.blocks WHERE id = $1")
            .bind(block_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.documents WHERE id = $1")
            .bind(doc_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.corpora WHERE id = $1")
            .bind(corpus_id)
            .execute(&pool)
            .await
            .ok();
    }

    /// Integration test: `GET /pages/project` returns 200 with fixture
    /// content.
    ///
    /// Inserts fixture project graph nodes (one Issue, one Feature); GETs
    /// /pages/project; asserts HTTP 200 and response body contains at least
    /// one issue title.
    ///
    /// Acceptance criterion: get_page_project_returns_200
    ///
    /// Skipped unless `DATABASE_URL` is set with the nexum schema migrated.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum migrations applied"]
    async fn get_page_project_returns_200() {
        let router = match make_test_router().await {
            Some(r) => r,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        // Insert fixture data via the project graph API.
        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = connect(&cfg).await.expect("pool creation failed");

        let issue_id = insert_issue(
            &pool,
            "Fixture issue for GET /pages/project test",
            Some("serve-test-issue"),
        )
        .await
        .expect("insert_issue failed");

        let _feature_id = insert_feature(&pool, issue_id, "Fixture feature for serve test")
            .await
            .expect("insert_feature failed");

        // Request the project page.
        let req = Request::builder()
            .method(Method::GET)
            .uri("/pages/project")
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "GET /pages/project must return 200"
        );

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body_str = String::from_utf8(body.to_vec()).unwrap();
        assert!(
            body_str.contains("Fixture issue for GET /pages/project test"),
            "body must contain fixture issue title, got: {:?}",
            body_str
        );

        // Cleanup — delete project nodes in reverse order.
        for node_id in [_feature_id, issue_id] {
            let block_id: Option<uuid::Uuid> = sqlx::query_scalar(
                "SELECT block_id FROM nexum.project_nodes WHERE id = $1",
            )
            .bind(node_id)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten();

            if let Some(bid) = block_id {
                sqlx::query("DELETE FROM nexum.links WHERE src = $1 OR dst = $1")
                    .bind(bid)
                    .execute(&pool)
                    .await
                    .ok();
            }
            sqlx::query("DELETE FROM nexum.project_nodes WHERE id = $1")
                .bind(node_id)
                .execute(&pool)
                .await
                .ok();
            if let Some(bid) = block_id {
                sqlx::query("DELETE FROM nexum.blocks WHERE id = $1")
                    .bind(bid)
                    .execute(&pool)
                    .await
                    .ok();
            }
        }
    }
}
