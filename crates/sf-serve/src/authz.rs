//! Route-level authorization — gates protected routes by role capability.
//!
//! The [`auth_middleware`](crate::auth::auth_middleware) validates the session
//! token and injects an [`AuthContext`] extension carrying the caller's
//! [`Role`]. This module layers *authorization* on top of that
//! *authentication*: middleware that inspects the already-injected
//! [`AuthContext`] and rejects the request with `403 Forbidden` when the role
//! lacks the capability the route requires.
//!
//! Two capability gates exist, mapping directly to the PRD §3 role model:
//!
//! - [`require_write`] — the route mutates state, so the caller's role must be
//!   able to write ([`Role::can_write`]). Auditor and Viewer are read-only and
//!   receive `403`.
//! - [`require_owner`] — the route sets policy / governs autonomy, which only
//!   the Owner may do ([`Role::is_owner`]). Every non-Owner role receives
//!   `403`.
//!
//! # Layering
//!
//! These gates must run *after* `auth_middleware` so the [`AuthContext`]
//! extension is present. In axum, `.layer(...)` applies bottom-up, so a sub
//! router gated like this:
//!
//! ```rust,ignore
//! write_routes
//!     .layer(middleware::from_fn(require_write))   // runs second
//!     .layer(middleware::from_fn_with_state(state, auth_middleware)) // runs first
//! ```
//!
//! runs `auth_middleware` first (injecting the context) and then
//! `require_write`. When a gated sub router is `.merge`d into a parent that
//! already applies `auth_middleware`, only the capability gate is added to the
//! sub router.
//!
//! # Defense in depth
//!
//! Route-level authorization layers on top of, and does not replace, the
//! per-schema RLS policies that isolate workspace data at the database
//! (`docs/architecture.md` §RLS policies are scoped per schema). A route gate
//! returns `403` before a handler runs; RLS additionally guarantees a handler
//! can never read or write another workspace's rows.

use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use sf_auth::AuthContext;

/// Reject the request with `403 Forbidden` unless the caller's role may write.
///
/// Intended for routes that create or mutate state. Auditor and Viewer are
/// read-only (PRD §3) and receive `403`; every other role passes through.
///
/// Returns `500` if no [`AuthContext`] extension is present — that indicates a
/// wiring bug (this gate was layered without `auth_middleware` in front of it),
/// not a client error.
pub async fn require_write(req: Request, next: Next) -> Response {
    match req.extensions().get::<AuthContext>() {
        Some(ctx) if ctx.role.can_write() => next.run(req).await,
        Some(ctx) => forbidden(&format!(
            "role '{}' is read-only and may not perform this write operation",
            ctx.role
        )),
        None => missing_context(),
    }
}

/// Reject the request with `403 Forbidden` unless the caller is the Owner.
///
/// Intended for policy / governance routes. Only the Owner sets policy and
/// governs autonomy (PRD §3); every other role receives `403`.
///
/// Returns `500` if no [`AuthContext`] extension is present (wiring bug).
pub async fn require_owner(req: Request, next: Next) -> Response {
    match req.extensions().get::<AuthContext>() {
        Some(ctx) if ctx.role.is_owner() => next.run(req).await,
        Some(ctx) => forbidden(&format!(
            "role '{}' may not set policy; this route requires the Owner role",
            ctx.role
        )),
        None => missing_context(),
    }
}

/// Build a `403 Forbidden` JSON response.
fn forbidden(reason: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": reason }))).into_response()
}

/// Build a `500` response for the "auth context missing" wiring bug.
fn missing_context() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "error": "authorization gate ran without an auth context; \
                      auth_middleware must precede it"
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        middleware,
        routing::{get, post},
        Extension, Router,
    };
    use http::{Method, Request as HttpRequest};
    use sf_auth::Role;
    use tower::ServiceExt as _;
    use uuid::Uuid;

    async fn ok() -> &'static str {
        "ok"
    }

    /// Build a router whose `/write` route is gated by [`require_write`] and
    /// whose `/owner` route is gated by [`require_owner`], with a fake
    /// [`AuthContext`] for `role` injected ahead of the gates (standing in for
    /// `auth_middleware`).
    fn router_for_role(role: Role) -> Router {
        let ctx = AuthContext::new(Uuid::new_v4(), Uuid::new_v4(), role);
        Router::new()
            .route("/read", get(ok))
            .route("/write", post(ok).layer(middleware::from_fn(require_write)))
            .route("/owner", post(ok).layer(middleware::from_fn(require_owner)))
            .layer(Extension(ctx))
    }

    async fn status_for(role: Role, method: Method, path: &str) -> StatusCode {
        let resp = router_for_role(role)
            .oneshot(
                HttpRequest::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        resp.status()
    }

    #[tokio::test]
    async fn viewer_blocked_on_write_allowed_on_read() {
        assert_eq!(
            status_for(Role::Viewer, Method::POST, "/write").await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status_for(Role::Viewer, Method::GET, "/read").await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn auditor_blocked_on_write_allowed_on_read() {
        assert_eq!(
            status_for(Role::Auditor, Method::POST, "/write").await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status_for(Role::Auditor, Method::GET, "/read").await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn writer_roles_pass_write_gate() {
        for role in [
            Role::Owner,
            Role::Requestor,
            Role::Steerer,
            Role::Collaborator,
            Role::Agent,
        ] {
            assert_eq!(
                status_for(role.clone(), Method::POST, "/write").await,
                StatusCode::OK,
                "{role} must pass the write gate"
            );
        }
    }

    #[tokio::test]
    async fn owner_only_route_rejects_non_owner() {
        assert_eq!(
            status_for(Role::Owner, Method::POST, "/owner").await,
            StatusCode::OK
        );
        for role in [
            Role::Requestor,
            Role::Steerer,
            Role::Collaborator,
            Role::Agent,
            Role::Auditor,
            Role::Viewer,
        ] {
            assert_eq!(
                status_for(role.clone(), Method::POST, "/owner").await,
                StatusCode::FORBIDDEN,
                "{role} must be rejected by the owner gate"
            );
        }
    }

    #[tokio::test]
    async fn gate_without_context_is_server_error() {
        // No AuthContext extension layered — simulates a wiring bug.
        let router =
            Router::new().route("/write", post(ok).layer(middleware::from_fn(require_write)));
        let resp = router
            .oneshot(
                HttpRequest::builder()
                    .method(Method::POST)
                    .uri("/write")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
