//! Auditor query surface (`/studio/audit/*`) — read-only, requires auth.
//!
//! Implements PRD US16 and the auditability constraint: an Auditor can inspect
//! *why* any decision or change exists and *what* it affected, by querying its
//! full causal chain — decision → error → session → requirement → code —
//! read-only, from the same operational store (issue #719).
//!
//! # Implemented routes
//!
//! | Method | Path                          | Description                              |
//! |--------|-------------------------------|------------------------------------------|
//! | GET    | `/studio/audit/decisions/{id}`| Causal chain for a decision/change       |
//!
//! The handler reuses [`nexum::decision_to_requirement_chain`], which itself
//! delegates the error→requirement→code hops to
//! [`nexum::error_to_cause_chain`]. No write path exists in this module: the
//! route is a pure projection over the property graph.
//!
//! # Authorization
//!
//! The surface is granted to read-only **auditor-equivalent** roles only.
//! Against today's coarse role model ([`sf_auth::Role`] = `Admin`/`Member`/
//! `Viewer`) that means [`Role::Viewer`] (read-only, the closest analogue to
//! the planned `Auditor`) and [`Role::Admin`] (the closest analogue to the
//! planned `Owner`). [`Role::Member`] — a read/write role — is denied with
//! `403 Forbidden`, satisfying the acceptance criterion "403 for
//! non-Auditor/non-Owner roles".
//!
//! When the seven-role model (sibling #711: `Owner`, `Auditor`, …) lands, swap
//! the role set in [`is_auditor_role`] for `Owner | Auditor`; nothing else in
//! this module changes.
//!
//! # Sparse data
//!
//! Populating the causal edges is out of scope here (deliverable A3). A
//! decision with no recorded motivating error returns `200 OK` with an
//! empty-but-valid chain envelope (`causal: null`, every downstream hop listed
//! in `missing_hops`) rather than an error.
//!
//! # Canonical docs
//!
//! - `docs/prd.md` US16 (auditor), Constraint (auditability).
//! - `docs/architecture.md` §Nexum, §Control Webapp.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Extension, Json, Router,
};
use nexum::{ChainNode, DecisionChain, DecisionChainError};
use serde_json::{json, Value};
use sf_auth::{AuthContext, Role};
use uuid::Uuid;

use crate::state::AppState;

/// Whether `role` may use the read-only auditor query surface.
///
/// See the module-level "Authorization" note for the mapping to the planned
/// seven-role model.
fn is_auditor_role(role: &Role) -> bool {
    matches!(role, Role::Viewer | Role::Admin)
}

/// Render a [`ChainNode`] as a stable JSON object for the audit envelope.
fn node_json(node: &ChainNode) -> Value {
    json!({
        "id": node.id,
        "type": node.entity_type,
        "properties": node.properties,
    })
}

/// Build the JSON envelope for a resolved [`DecisionChain`].
///
/// Shape (stable contract for the auditor UI, #719 out-of-scope follow-up):
///
/// ```json
/// {
///   "decision":     { "id", "type", "properties" },
///   "error":        { ... } | null,
///   "session":      { ... } | null,
///   "user":         { ... } | null,
///   "requirement":  { ... } | null,
///   "code":         { ... } | null,
///   "missing_hops": ["error", "session", ...],
///   "complete":     false
/// }
/// ```
fn chain_envelope(chain: &DecisionChain) -> Value {
    let causal = chain.causal.as_ref();
    json!({
        "decision": node_json(&chain.decision),
        "error": causal.map(|c| node_json(&c.error)),
        "session": causal.and_then(|c| c.session.as_ref()).map(node_json),
        "user": causal.and_then(|c| c.user.as_ref()).map(node_json),
        "requirement": causal.and_then(|c| c.requirement.as_ref()).map(node_json),
        "code": causal.and_then(|c| c.code.as_ref()).map(node_json),
        "missing_hops": chain.missing_hops,
        "complete": chain.missing_hops.is_empty(),
    })
}

/// `GET /studio/audit/decisions/{id}` — causal chain for a decision/change.
///
/// Read-only: the handler performs no mutation. Reuses
/// [`nexum::decision_to_requirement_chain`].
///
/// # Responses
///
/// - `200 OK` with the causal-chain envelope for a known decision/change id
///   (including an empty-but-valid chain when causal data is sparse).
/// - `403 Forbidden` when the caller's role is not auditor-equivalent.
/// - `404 Not Found` when no decision/change has that id.
/// - `500 Internal Server Error` on a database error.
pub async fn get_decision_chain(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    // Authorization: read-only auditor surface.
    if !is_auditor_role(&ctx.role) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "auditor or owner role required"})),
        )
            .into_response();
    }

    // Propagate workspace context for RLS before reading.
    if let Err(e) = sf_db::acquire_workspace(state.pool(), ctx.principal_id()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response();
    }

    match nexum::decision_to_requirement_chain(state.pool(), id).await {
        Ok(chain) => (StatusCode::OK, Json(chain_envelope(&chain))).into_response(),

        Err(DecisionChainError::DecisionNotFound(id)) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "decision not found", "id": id})),
        )
            .into_response(),

        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("audit query error: {}", e)})),
        )
            .into_response(),
    }
}

/// Build the auditor query router.
///
/// Routes here are wrapped in the auth middleware by [`crate::build_router`].
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/studio/audit/decisions/{id}", get(get_decision_chain))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http::{Method, Request, StatusCode};
    use serde_json::json;
    use tower::ServiceExt as _;

    use crate::{build_router, ServeConfig};
    use sf_db::{connect, DbConfig};

    // ── Unit tests (no database) ──────────────────────────────────────────────

    #[test]
    fn viewer_and_admin_are_auditor_roles_member_is_not() {
        assert!(
            is_auditor_role(&Role::Viewer),
            "viewer ≈ auditor (read-only)"
        );
        assert!(is_auditor_role(&Role::Admin), "admin ≈ owner");
        assert!(
            !is_auditor_role(&Role::Member),
            "member is a write role and must be denied"
        );
    }

    #[test]
    fn envelope_for_sparse_chain_is_empty_but_valid() {
        let chain = DecisionChain {
            decision: ChainNode {
                id: Uuid::new_v4(),
                entity_type: "decision".into(),
                properties: json!({"rule": "r1"}),
            },
            causal: None,
            missing_hops: vec![
                "error".into(),
                "session".into(),
                "user".into(),
                "requirement".into(),
                "code".into(),
            ],
        };
        let env = chain_envelope(&chain);
        assert!(env["decision"]["type"] == "decision");
        assert!(env["error"].is_null(), "sparse chain → null error node");
        assert!(env["requirement"].is_null());
        assert_eq!(env["complete"], json!(false));
        assert_eq!(env["missing_hops"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn envelope_for_complete_chain_marks_complete() {
        use nexum::CausalChain;
        let make = |t: &str| ChainNode {
            id: Uuid::new_v4(),
            entity_type: t.into(),
            properties: json!({}),
        };
        let chain = DecisionChain {
            decision: make("decision"),
            causal: Some(CausalChain {
                error: make("error"),
                session: Some(make("session")),
                user: Some(make("user")),
                requirement: Some(make("requirement")),
                code: Some(make("code")),
                missing_hops: vec![],
            }),
            missing_hops: vec![],
        };
        let env = chain_envelope(&chain);
        assert_eq!(env["complete"], json!(true));
        assert_eq!(env["requirement"]["type"], "requirement");
        assert_eq!(env["code"]["type"], "code");
    }

    // ── Integration tests (require DATABASE_URL) ──────────────────────────────

    /// Build a test router backed by a live Postgres pool, or `None` if
    /// `DATABASE_URL` is unset.
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

    /// Mint a session token for `workspace_id` with `role` directly through the
    /// session store so an integration test can reach the protected route.
    async fn mint_session(pool: &sqlx::PgPool, workspace_id: uuid::Uuid, role: Role) -> String {
        let store = sf_auth::SessionStore::new(pool.clone(), Some(3600));
        store
            .issue(workspace_id, workspace_id, role)
            .await
            .expect("issue session failed")
            .token
            .to_string()
    }

    /// Insert a bare decision entity and return its id.
    async fn insert_decision(pool: &sqlx::PgPool, workspace_id: uuid::Uuid) -> uuid::Uuid {
        sqlx::query_scalar(
            "INSERT INTO nexum.entities (workspace_id, type, properties) VALUES ($1, 'decision', $2) RETURNING id",
        )
        .bind(workspace_id)
        .bind(json!({"rule": "audit-route-test"}))
        .fetch_one(pool)
        .await
        .expect("decision insert failed")
    }

    /// Acceptance criterion: the auditor route returns the documented
    /// causal-chain envelope for a known decision, and returns an
    /// empty-but-valid chain when the causal data is sparse.
    ///
    /// Skipped unless `DATABASE_URL` + `WORKSPACE_ID` are set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum + auth schema and WORKSPACE_ID"]
    async fn auditor_route_returns_empty_but_valid_chain_for_sparse_decision() {
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

        let decision_id = insert_decision(&pool, workspace_id).await;
        // Auditor-equivalent read-only role.
        let token = mint_session(&pool, workspace_id, Role::Viewer).await;

        let req = Request::builder()
            .method(Method::GET)
            .uri(format!("/studio/audit/decisions/{decision_id}"))
            .header("X-Session-Token", token)
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "known decision → 200");

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let envelope: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            envelope["decision"]["id"].as_str(),
            Some(decision_id.to_string().as_str()),
            "envelope must echo the decision id"
        );
        assert_eq!(
            envelope["complete"],
            json!(false),
            "sparse decision → incomplete chain"
        );
        assert!(
            envelope["requirement"].is_null(),
            "no requirement hop on sparse data"
        );

        sqlx::query("DELETE FROM nexum.entities WHERE id = $1")
            .bind(decision_id)
            .execute(&pool)
            .await
            .ok();
    }

    /// Acceptance criterion: the route is denied (403) for a non-auditor,
    /// non-owner role (`Member`), proving role-gating.
    ///
    /// Skipped unless `DATABASE_URL` + `WORKSPACE_ID` are set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum + auth schema and WORKSPACE_ID"]
    async fn auditor_route_forbidden_for_member_role() {
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

        let decision_id = insert_decision(&pool, workspace_id).await;
        // Member is a read/write role → not an auditor/owner.
        let token = mint_session(&pool, workspace_id, Role::Member).await;

        let req = Request::builder()
            .method(Method::GET)
            .uri(format!("/studio/audit/decisions/{decision_id}"))
            .header("X-Session-Token", token)
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "member role must be forbidden from the auditor surface"
        );

        sqlx::query("DELETE FROM nexum.entities WHERE id = $1")
            .bind(decision_id)
            .execute(&pool)
            .await
            .ok();
    }
}
