//! Superfield HTTP serving layer.
//!
//! Exposes the app and control-panel APIs, with all requests passing through
//! the unified auth/session layer ([`sf_auth`]).
//!
//! # Architecture
//!
//! Every request goes through [`auth_middleware`] which:
//!
//! 1. Extracts the `X-Session-Token` header (or `session` cookie).
//! 2. Calls [`sf_auth::SessionStore::validate`] — returns [`AuthContext`]
//!    containing workspace, user, and role.
//! 3. Injects the [`AuthContext`] as an [axum request extension] so route
//!    handlers can access it without touching auth logic themselves.
//!
//! Route handlers that need a database connection call
//! [`sf_db::acquire_workspace`] with `ctx.principal_id()` so that
//! `app.current_principal_id` is set via `SET LOCAL` before any data-modifying
//! statement runs — enabling per-schema RLS policies to fire correctly.
//!
//! # Public surface
//!
//! - [`ServeConfig`] — typed configuration (bind address, session TTL, …).
//! - [`build_router`] — constructs the axum [`Router`] (useful for tests).
//! - [`serve`] — binds a TCP listener and drives the server until the process
//!   exits.
//! - [`ServeError`] — top-level error type.
//!
//! See `docs/architecture.md` §Control Webapp for the full route inventory.
//!
//! # Static asset serving
//!
//! When `CONTROL_ASSETS_DIR` is set in the environment, `GET /*` requests are
//! served from that directory using [`tower_http::services::ServeDir`].  Any
//! path not found on disk falls back to `index.html` so client-side SPA routing
//! works correctly.  When `CONTROL_ASSETS_DIR` is unset, a minimal placeholder
//! HTML is returned so health checks always succeed.

pub mod auth;
pub mod error;
pub mod loop_handle;
pub mod routes;
pub mod state;

#[cfg(test)]
mod tests;

use axum::{
    body::Body,
    http::Request,
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use sqlx::PgPool;
use std::{net::SocketAddr, path::PathBuf};
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};

pub use auth::auth_middleware;
pub use error::ServeError;
pub use loop_handle::{LoopHandle, LoopHandleError, NoopLoopHandle};
pub use state::AppState;

// Re-export AuthContext so callers don't need to depend on sf-auth directly.
pub use sf_auth::AuthContext;

/// Configuration for the HTTP server.
///
/// Constructed by the binary entrypoint and passed to [`serve`] /
/// [`build_router`].
#[derive(Debug, Clone)]
pub struct ServeConfig {
    /// Socket address to bind (e.g. `"0.0.0.0:7000".parse().unwrap()`).
    pub bind_addr: SocketAddr,

    /// Default session lifetime in seconds.  `None` → 86 400 (24 h).
    pub session_ttl_secs: Option<i64>,

    /// Absolute path to the compiled browser UI static assets directory.
    ///
    /// When `Some`, `GET /*` is served from this directory with an SPA
    /// fallback to `index.html`.  When `None`, a minimal placeholder HTML is
    /// returned.  Populated from `CONTROL_ASSETS_DIR` by the entrypoint.
    pub assets_dir: Option<PathBuf>,
}

impl Default for ServeConfig {
    fn default() -> Self {
        Self {
            bind_addr: "0.0.0.0:7000".parse().expect("static addr"),
            session_ttl_secs: None,
            assets_dir: None,
        }
    }
}

/// Build the axum [`Router`] for the Superfield serving layer.
///
/// Accepts the shared [`PgPool`] and [`ServeConfig`] so the same router can
/// be used both in production (via [`serve`]) and in integration tests (bound
/// to a random port via [`axum_test`] / `tokio::net::TcpListener`).
///
/// # Route groups
///
/// | Prefix             | Auth required | Description                        |
/// |--------------------|---------------|------------------------------------|
/// | `GET /health`      | No            | Liveness probe                     |
/// | `/api/auth/*`      | No            | Session issue/revoke               |
/// | `/api/*`           | Yes           | App API (workspace-scoped)         |
/// | `/studio/*`        | Yes           | Control-panel API                  |
/// | `/orchestrator/*`  | Yes           | Orchestrator control endpoints     |
/// | `/pages/*`         | No            | Knowledge-base page projections    |
/// | `GET /*`           | No            | Static browser UI assets           |
///
/// All authenticated routes use [`auth_middleware`], which validates the
/// session token and injects an [`AuthContext`] extension.
pub fn build_router(pool: PgPool, cfg: &ServeConfig) -> Router {
    use axum::middleware;

    let session_store = sf_auth::SessionStore::new(pool.clone(), cfg.session_ttl_secs);
    let state = AppState::new(pool, session_store);

    // Public auth routes — no session required.
    let auth_routes = routes::auth::router(state.clone());

    // Public page projection routes — unauthenticated (localhost-only for
    // milestone 1; see issue #492 scope).
    let page_routes = routes::pages::router(state.clone());

    // Protected routes — all require a valid session.
    let protected = Router::new()
        .merge(routes::api::router(state.clone()))
        .merge(routes::studio::router(state.clone()))
        .merge(routes::orchestrator::router(state.clone()))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ));

    // Static asset fallback — serves the compiled browser UI.
    let static_fallback = build_static_router(cfg.assets_dir.clone());

    Router::new()
        // Liveness probe — unauthenticated, always returns 200.
        .route("/health", get(health))
        .merge(auth_routes)
        .merge(page_routes)
        .merge(protected)
        .merge(static_fallback)
}

/// `GET /health` — unauthenticated liveness probe.
///
/// Returns `200 OK` with a plain JSON body so load balancers and E2E setup
/// scripts can wait for the server to be ready without a database session.
async fn health() -> impl IntoResponse {
    axum::Json(serde_json::json!({"status": "ok"}))
}

/// Build the static asset fallback router.
///
/// When `assets_dir` is `Some`, requests to unknown paths are served from the
/// given directory using [`tower_http::services::ServeDir`].  Any path not
/// found on disk falls back to `index.html` (SPA routing).
///
/// When `assets_dir` is `None`, a minimal placeholder HTML is returned so
/// the server is always reachable for health checks and integration tests.
fn build_static_router(assets_dir: Option<PathBuf>) -> Router {
    if let Some(dir) = assets_dir {
        let index = dir.join("index.html");
        let service = ServeDir::new(&dir).not_found_service(ServeFile::new(index));
        // Route all remaining GET requests to the static file service.
        // axum's `Router::fallback_service` is the correct integration point
        // for tower services.
        Router::new().fallback_service(service)
    } else {
        // Minimal placeholder — keeps GET / healthy without a built UI.
        Router::new().fallback(placeholder_handler)
    }
}

/// Fallback handler when no `assets_dir` is configured.
///
/// Returns a minimal HTML page so the server is reachable for health checks
/// and E2E setup even when the browser UI has not been built.
async fn placeholder_handler(_req: Request<Body>) -> Response {
    Html(
        "<!doctype html><html><head><title>Superfield Studio</title></head>\
         <body><p>Studio server is running. Build the web app to serve the full UI.</p>\
         </body></html>",
    )
    .into_response()
}

/// Bind to `cfg.bind_addr` and serve until the process is interrupted.
///
/// This is the production entry point called from `crates/superfield/src/main.rs`.
///
/// # Errors
///
/// Returns [`ServeError::Bind`] if the port cannot be bound, or
/// [`ServeError::Serve`] if the server loop fails.
pub async fn serve(pool: PgPool, cfg: ServeConfig) -> Result<(), ServeError> {
    let router = build_router(pool, &cfg);
    let listener = TcpListener::bind(cfg.bind_addr)
        .await
        .map_err(|e| ServeError::Bind(cfg.bind_addr, e))?;

    axum::serve(listener, router)
        .await
        .map_err(ServeError::Serve)?;

    Ok(())
}
