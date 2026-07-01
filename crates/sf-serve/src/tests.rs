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
            assets_dir: None,
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
            .issue(ws, user, Role::Collaborator)
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
        assert_eq!(json["role"].as_str().unwrap(), "collaborator");
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
            .issue(ws_a, user, Role::Owner)
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

    /// `GET /analytics/check-runs?sha=<sha>` requires auth: a request without a
    /// session token is rejected with 401 by the auth middleware before it ever
    /// reaches the handler (acceptance: API test for auth on the non-stream CI
    /// route, issue #713).
    ///
    /// Like the other middleware-path tests this needs the auth schema, so it is
    /// `#[ignore]`d unless DATABASE_URL is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn check_runs_unauthenticated_returns_401() {
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
            .uri("/analytics/check-runs?sha=deadbeef")
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "missing token must yield 401 on /analytics/check-runs"
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

    /// Issue a session for `role`, then send `method path` with the token and
    /// return the HTTP status. Used by the route-authorization tests below.
    async fn status_with_role(
        router: axum::Router,
        session_store: &SessionStore,
        role: Role,
        method: Method,
        path: &str,
    ) -> StatusCode {
        let ws = Uuid::new_v4();
        let user = Uuid::new_v4();
        let session = session_store
            .issue(ws, user, role)
            .await
            .expect("session issue failed");
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header("x-session-token", session.token.to_string())
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        router.oneshot(req).await.unwrap().status()
    }

    /// Acceptance (issue #711): a Viewer token is rejected with 403 on a write
    /// route and accepted with 200 on a read route. The write route here is
    /// `POST /studio/steer` (gated by `require_write`); the read route is
    /// `GET /studio/status`.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn viewer_forbidden_on_write_allowed_on_read() {
        let (router, store) = match make_test_router().await {
            Some(t) => t,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        // Read route → 200.
        let read = status_with_role(
            router.clone(),
            &store,
            Role::Viewer,
            Method::GET,
            "/studio/status",
        )
        .await;
        assert_eq!(read, StatusCode::OK, "Viewer must read /studio/status");

        // Write route → 403.
        let write =
            status_with_role(router, &store, Role::Viewer, Method::POST, "/studio/steer").await;
        assert_eq!(
            write,
            StatusCode::FORBIDDEN,
            "Viewer must be forbidden on a write route"
        );
    }

    /// Acceptance (issue #711): an Auditor token (read-only) is rejected with
    /// 403 on a write route and accepted with 200 on a read route.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn auditor_forbidden_on_write_allowed_on_read() {
        let (router, store) = match make_test_router().await {
            Some(t) => t,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        let read = status_with_role(
            router.clone(),
            &store,
            Role::Auditor,
            Method::GET,
            "/studio/status",
        )
        .await;
        assert_eq!(read, StatusCode::OK, "Auditor must read /studio/status");

        let write =
            status_with_role(router, &store, Role::Auditor, Method::POST, "/studio/steer").await;
        assert_eq!(
            write,
            StatusCode::FORBIDDEN,
            "Auditor must be forbidden on a write route"
        );
    }

    /// Acceptance (issue #835): the reconciled Studio feature-update route.
    ///
    /// Drives the exact route+method+payload the control frontend
    /// (`FeaturePaneController.patchFeature`) now issues —
    /// `POST /studio/issues/update { id, title }` — end to end against the live
    /// nexum project graph, proving client and server agree on a single
    /// feature-update contract:
    ///
    /// 1. A write-capable session creates an Issue via `POST /studio/issues`.
    /// 2. `POST /studio/issues/update { id, title }` returns `200 OK`.
    /// 3. `GET /studio/issues` reads the node back with the updated
    ///    title/content (the write went through the project graph).
    /// 4. A read-only Viewer session is rejected with `403 Forbidden` by the
    ///    `require_write` gate on the update route.
    ///
    /// LOUD by construction: this test is `#[ignore]`d (DB-gated) and executes
    /// in the `rust-test-seam` CI job, which provisions `DATABASE_URL` +
    /// migrations and runs it under `--run-ignored all`. If `DATABASE_URL` is
    /// absent there, `make_test_router` yields `None` and this test PANICS —
    /// never a silent skip / false green.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with the nexum project-graph schema migrated"]
    async fn studio_issue_update_route_writes_through_project_graph() {
        let (router, store) = make_test_router().await.expect(
            "DATABASE_URL must be set for the DB-gated studio update test \
             (loud-skip: this test asserts the substrate, it must never no-op)",
        );

        // A write-capable session (Collaborator passes `require_write`).
        let session = store
            .issue(Uuid::new_v4(), Uuid::new_v4(), Role::Collaborator)
            .await
            .expect("session issue failed");
        let token = session.token.to_string();

        // 1. Create an Issue node through the studio API.
        let unique = Uuid::new_v4();
        let orig_title = format!("issue-835-orig-{unique}");
        let create = Request::builder()
            .method(Method::POST)
            .uri("/studio/issues")
            .header("x-session-token", &token)
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({ "title": orig_title }).to_string(),
            ))
            .unwrap();
        let create_resp = router.clone().oneshot(create).await.unwrap();
        assert_eq!(
            create_resp.status(),
            StatusCode::CREATED,
            "POST /studio/issues must create the node"
        );
        let create_body = axum::body::to_bytes(create_resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Value = serde_json::from_slice(&create_body).unwrap();
        let issue_id = created["issue_id"]
            .as_str()
            .expect("issue_id in create response")
            .to_string();

        // 2. Update it via the reconciled route+method+payload the frontend
        //    issues: POST /studio/issues/update { id, title }.
        let new_title = format!("issue-835-reconciled-{unique}");
        let update = Request::builder()
            .method(Method::POST)
            .uri("/studio/issues/update")
            .header("x-session-token", &token)
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({ "id": issue_id, "title": new_title }).to_string(),
            ))
            .unwrap();
        let update_resp = router.clone().oneshot(update).await.unwrap();
        assert_eq!(
            update_resp.status(),
            StatusCode::OK,
            "POST /studio/issues/update must 2xx for a write-capable session"
        );

        // 3. Read the node back and assert the content changed.
        let list = Request::builder()
            .method(Method::GET)
            .uri("/studio/issues?node_type=Issue")
            .header("x-session-token", &token)
            .body(Body::empty())
            .unwrap();
        let list_resp = router.clone().oneshot(list).await.unwrap();
        assert_eq!(list_resp.status(), StatusCode::OK);
        let list_body = axum::body::to_bytes(list_resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let listed: Value = serde_json::from_slice(&list_body).unwrap();
        let nodes = listed["nodes"].as_array().expect("nodes array in list");
        let found = nodes
            .iter()
            .find(|n| n["id"].as_str() == Some(issue_id.as_str()))
            .expect("updated node must be present in GET /studio/issues");
        assert_eq!(
            found["title"].as_str(),
            Some(new_title.as_str()),
            "the node title/content must reflect the update written through the project graph"
        );

        // 4. `require_write`: a read-only Viewer is rejected on the update route.
        let viewer = store
            .issue(Uuid::new_v4(), Uuid::new_v4(), Role::Viewer)
            .await
            .expect("viewer session issue failed");
        let denied = Request::builder()
            .method(Method::POST)
            .uri("/studio/issues/update")
            .header("x-session-token", viewer.token.to_string())
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({ "id": issue_id, "title": "must-not-apply" }).to_string(),
            ))
            .unwrap();
        let denied_resp = router.oneshot(denied).await.unwrap();
        assert_eq!(
            denied_resp.status(),
            StatusCode::FORBIDDEN,
            "a read-only Viewer must be forbidden by require_write on /studio/issues/update"
        );
    }

    /// Acceptance (issue #711): an Owner-only route (`POST /orchestrator/start`,
    /// gated by `require_owner`) returns 403 for a non-Owner role and is not
    /// blocked by the authorization gate for the Owner.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn owner_only_route_forbidden_for_non_owner() {
        let (router, store) = match make_test_router().await {
            Some(t) => t,
            None => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };

        // Collaborator may write in general but is NOT the Owner → 403 on the
        // Owner-gated route.
        let non_owner = status_with_role(
            router.clone(),
            &store,
            Role::Collaborator,
            Method::POST,
            "/orchestrator/start",
        )
        .await;
        assert_eq!(
            non_owner,
            StatusCode::FORBIDDEN,
            "non-Owner must be forbidden on the Owner-only route"
        );

        // Owner passes the authorization gate (the request reaches the handler;
        // it does not return 403).
        let owner = status_with_role(
            router,
            &store,
            Role::Owner,
            Method::POST,
            "/orchestrator/start",
        )
        .await;
        assert_ne!(
            owner,
            StatusCode::FORBIDDEN,
            "Owner must pass the Owner-only authorization gate"
        );
    }
}

/// Offline unit tests for the additive route-module registration seam
/// (dev-scout, issue #677).
///
/// These tests build the router without a live database. axum panics at
/// router **build** time if two merged modules register colliding routes, so a
/// successful `build_router` call is itself the assertion that the additive
/// `routes::project` (#672) and `routes::ingest` (#673) seams register without
/// conflict. No DB connection is opened — the pool is created lazily.
#[cfg(test)]
mod additive_route_seam {
    use std::net::SocketAddr;

    use sqlx::postgres::PgPoolOptions;

    use crate::{build_router, ServeConfig};

    /// A lazily-connected pool that never actually dials Postgres — enough to
    /// construct the router (route registration touches no connection).
    fn lazy_pool() -> sqlx::PgPool {
        PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy("postgres://localhost/placeholder")
            .expect("lazy pool construction must succeed")
    }

    fn test_cfg() -> ServeConfig {
        ServeConfig {
            bind_addr: "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
            session_ttl_secs: Some(3600),
            assets_dir: None,
        }
    }

    /// The additive `project` and `ingest` route modules merge into the
    /// protected route group without colliding — `build_router` does not panic.
    #[tokio::test]
    async fn additive_modules_register_without_colliding() {
        let pool = lazy_pool();
        let cfg = test_cfg();
        // If `routes::project` and `routes::ingest` (or any other merged
        // module) registered an overlapping route, axum's `Router::merge`
        // would panic here at build time.
        let _router = build_router(pool, &cfg);
    }

    /// Each dev-scout seam module exposes a `router(state)` constructor that
    /// builds in isolation. Today they register no routes (no-op stubs), so the
    /// real assertion is that the public seam signature compiles and builds.
    #[tokio::test]
    async fn seam_module_routers_build_in_isolation() {
        use crate::routes;
        use crate::state::AppState;

        let pool = lazy_pool();
        let session_store = sf_auth::SessionStore::new(pool.clone(), Some(3600));
        let state = AppState::new(pool, session_store);

        let _project = routes::project::router(state.clone());
        let _ingest = routes::ingest::router(state);
    }
}
