//! Auth middleware — validates session tokens and injects [`AuthContext`].
//!
//! # How it works
//!
//! Every request that passes through this middleware is checked for a valid
//! session token.  The token is looked up in this order:
//!
//! 1. `X-Session-Token` header — preferred for API clients.
//! 2. `session` cookie — used by the browser UI.
//!
//! On a valid token the middleware calls [`SessionStore::validate`] to obtain
//! an [`AuthContext`] (workspace, user, role) and injects it as an axum
//! [request extension].  Route handlers extract it with
//! `Extension<AuthContext>`.
//!
//! On an invalid or missing token the middleware short-circuits with
//! `401 Unauthorized`.
//!
//! # Cross-workspace protection
//!
//! The workspace identity embedded in [`AuthContext`] is set as
//! `app.current_principal_id` on every database connection via
//! [`sf_db::acquire_workspace`].  RLS policies on every schema reference this
//! setting and reject rows whose `workspace_id` does not match — making
//! cross-workspace data access impossible at the database layer.
//!
//! See `docs/architecture.md` §RLS policies are scoped per schema.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use sf_auth::{AuthContext, SessionError};
use uuid::Uuid;

use crate::state::AppState;

/// Axum middleware function that validates the session token on every request.
///
/// Injects [`AuthContext`] as a request extension if the token is valid.
/// Returns `401` if the token is absent, invalid, expired, or revoked.
/// Returns `403` if the token can be parsed but is otherwise rejected.
///
/// # Usage
///
/// ```rust,ignore
/// Router::new()
///     .route("/api/some-endpoint", get(handler))
///     .layer(middleware::from_fn_with_state(state.clone(), auth_middleware));
/// ```
pub async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    // 1. Extract the session token from the request.
    let token_str = extract_token(&req);

    let token_str = match token_str {
        Some(t) => t,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "missing session token"})),
            )
                .into_response()
        }
    };

    // 2. Parse the token as a UUID.
    let token = match token_str.parse::<Uuid>() {
        Ok(t) => t,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "invalid session token format"})),
            )
                .into_response()
        }
    };

    // 3. Validate the token against the store.
    let ctx: AuthContext = match state.session_store().validate(token).await {
        Ok(ctx) => ctx,
        Err(SessionError::NotFound) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "session not found"})),
            )
                .into_response()
        }
        Err(SessionError::Expired) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "session expired"})),
            )
                .into_response()
        }
        Err(SessionError::Revoked) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "session revoked"})),
            )
                .into_response()
        }
        Err(SessionError::UnknownRole(r)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("unknown role in database: {}", r)})),
            )
                .into_response()
        }
        Err(SessionError::Db(e)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("database error: {}", e)})),
            )
                .into_response()
        }
    };

    // 4. Inject the validated context as a request extension.
    req.extensions_mut().insert(ctx);

    next.run(req).await
}

/// Extract the raw session token string from a request.
///
/// Tries (in order):
/// 1. `X-Session-Token` header.
/// 2. `session=<value>` in the `Cookie` header.
fn extract_token(req: &Request) -> Option<String> {
    // Header takes precedence.
    if let Some(val) = req.headers().get("x-session-token") {
        if let Ok(s) = val.to_str() {
            return Some(s.to_owned());
        }
    }

    // Fall back to cookie.
    if let Some(cookie_hdr) = req.headers().get("cookie") {
        if let Ok(cookie_str) = cookie_hdr.to_str() {
            for part in cookie_str.split(';') {
                let part = part.trim();
                if let Some(val) = part.strip_prefix("session=") {
                    return Some(val.to_owned());
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    fn make_req_with_header(key: &str, val: &str) -> Request<axum::body::Body> {
        Request::builder()
            .header(key, val)
            .body(axum::body::Body::empty())
            .unwrap()
    }

    #[test]
    fn extract_token_from_header() {
        let req = make_req_with_header("x-session-token", "abc-123");
        assert_eq!(extract_token(&req), Some("abc-123".to_owned()));
    }

    #[test]
    fn extract_token_from_cookie() {
        let req = make_req_with_header("cookie", "other=val; session=token-456; more=x");
        assert_eq!(extract_token(&req), Some("token-456".to_owned()));
    }

    #[test]
    fn header_takes_precedence_over_cookie() {
        let req = Request::builder()
            .header("x-session-token", "header-token")
            .header("cookie", "session=cookie-token")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(extract_token(&req), Some("header-token".to_owned()));
    }

    #[test]
    fn no_token_returns_none() {
        let req = Request::builder()
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(extract_token(&req), None);
    }
}
