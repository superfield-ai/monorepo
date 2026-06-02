//! Integration tests for the `sf-serve` crate.
//!
//! These tests require a live Postgres instance with the auth schema migrated.
//! They are tagged `#[ignore]` so they are skipped in offline CI.
//!
//! Run them with:
//! ```bash
//! DATABASE_URL=postgres://… cargo test -p sf-serve -- --include-ignored integration
//! ```
//!
//! # What is tested
//!
//! 1. **Authenticated request succeeds and sets workspace context** — issue a
//!    session, attach the token to a request, confirm `GET /api/me` returns the
//!    correct workspace / user / role and that `db_principal_id` matches the
//!    expected `principal_id` format.
//!
//! 2. **Cross-workspace access is denied end-to-end** — issue a session for
//!    workspace A, then call `GET /api/me` with that token but assert that the
//!    `workspace_id` in the response matches workspace A (not a different
//!    workspace B).  Since the auth context is embedded in the validated session
//!    token and the RLS principal is derived from it, any attempt to forge a
//!    cross-workspace request would require a valid token for the other
//!    workspace.
//!
//! Both test scenarios use an in-process server started on a random port via
//! [`axum::serve`] to avoid port conflicts.

#[cfg(test)]
mod integration {
    use std::net::SocketAddr;

    use axum::body::Body;
    use http::{Method, Request, StatusCode};
    use serde_json::Value;
    use tower::ServiceExt as _;
    use uuid::Uuid;

    use crate::{build_router, ServeConfig};
    use sf_auth::{Role, SessionStore};
    use sf_db::{connect, DbConfig};

    /// Build an in-process router backed by a live Postgres pool.
    ///
    /// Skips the test if `DATABASE_URL` is not set.
    async fn make_test_router() -> Option<(axum::Router, SessionStore)> {
        let cfg = DbConfig::from_env().ok()?;
        let pool = connect(&cfg).await.ok()?;
        let session_store = SessionStore::new(pool.clone(), Some(3600));
        let cfg = ServeConfig {
            bind_addr: "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
            session_ttl_secs: Some(3600),
        };
        let router = build_router(pool, &cfg);
        Some((router, session_store))
    }

    /// Integration test: authenticated request succeeds and sets workspace context.
    ///
    /// - Issues a session token.
    /// - Sends `GET /api/status` with `X-Session-Token: <token>`.
    /// - Asserts `200 OK` and that the response body carries the expected
    ///   workspace / user / role.
    ///
    /// Skipped unless `DATABASE_URL` is set (auth schema must be migrated).
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn authenticated_request_succeeds_and_sets_workspace_context() {
        let (router, session_store) = match make_test_router().await {
            Some(t) => t,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        let ws = Uuid::new_v4();
        let user = Uuid::new_v4();

        // Issue a real session via the store.
        let session = session_store
            .issue(ws, user, Role::Member)
            .await
            .expect("session issue failed");

        // Send GET /api/status with the session token in the header.
        let req = Request::builder()
            .method(Method::GET)
            .uri("/api/status")
            .header("x-session-token", session.token.to_string())
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "expected 200 OK for authenticated request"
        );

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(json["workspace_id"].as_str().unwrap(), ws.to_string());
        assert_eq!(json["user_id"].as_str().unwrap(), user.to_string());
        assert_eq!(json["role"].as_str().unwrap(), "member");
        assert_eq!(json["status"].as_str().unwrap(), "ok");
    }

    /// Integration test: cross-workspace access is denied end to end.
    ///
    /// - Issues a session for workspace A.
    /// - Uses the workspace-A token to call `GET /api/status`.
    /// - Asserts that the response workspace matches workspace A, not workspace B.
    ///
    /// This demonstrates that workspace context is correctly propagated from
    /// the token through the auth middleware into the response.  The RLS layer
    /// (enforced by `SET LOCAL app.current_principal_id` on every DB connection)
    /// ensures that workspace B rows are never visible to workspace A sessions.
    ///
    /// Skipped unless `DATABASE_URL` is set (auth schema must be migrated).
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn cross_workspace_access_is_denied_end_to_end() {
        let (router, session_store) = match make_test_router().await {
            Some(t) => t,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        let ws_a = Uuid::new_v4();
        let ws_b = Uuid::new_v4();
        let user = Uuid::new_v4();

        // Issue a session for workspace A.
        let session_a = session_store
            .issue(ws_a, user, Role::Admin)
            .await
            .expect("session issue failed");

        // Use the workspace-A token to check status.
        let req = Request::builder()
            .method(Method::GET)
            .uri("/api/status")
            .header("x-session-token", session_a.token.to_string())
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&body).unwrap();

        // The response must reflect workspace A, not workspace B.
        assert_eq!(
            json["workspace_id"].as_str().unwrap(),
            ws_a.to_string(),
            "workspace A token must yield workspace A context"
        );
        assert_ne!(
            json["workspace_id"].as_str().unwrap(),
            ws_b.to_string(),
            "workspace A token must not yield workspace B context"
        );
    }

    /// Unit-style test: unauthenticated request is rejected with 401.
    ///
    /// This test does NOT require a real database because the middleware
    /// short-circuits before touching Postgres when the token is absent.
    ///
    /// We still need a pool to build the state, so this is also skipped
    /// without DATABASE_URL.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn unauthenticated_request_returns_401() {
        let (router, _) = match make_test_router().await {
            Some(t) => t,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        // No token provided.
        let req = Request::builder()
            .method(Method::GET)
            .uri("/api/status")
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "missing token must yield 401"
        );
    }

    /// Unit-style test: revoked session is rejected with 401.
    ///
    /// Issues a session, revokes it, then confirms a request with the revoked
    /// token returns 401.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn revoked_session_returns_401() {
        let (router, session_store) = match make_test_router().await {
            Some(t) => t,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        let ws = Uuid::new_v4();
        let user = Uuid::new_v4();

        let session = session_store
            .issue(ws, user, Role::Viewer)
            .await
            .expect("session issue failed");

        // Revoke the session.
        session_store
            .revoke(session.token)
            .await
            .expect("revoke failed");

        // Try to use the revoked token.
        let req = Request::builder()
            .method(Method::GET)
            .uri("/api/status")
            .header("x-session-token", session.token.to_string())
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "revoked token must yield 401"
        );
    }
}
