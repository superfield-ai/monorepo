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

pub mod auth;
pub mod error;
pub mod routes;
pub mod state;

#[cfg(test)]
mod tests;

use axum::Router;
use sqlx::PgPool;
use std::net::SocketAddr;
use tokio::net::TcpListener;

pub use auth::auth_middleware;
pub use error::ServeError;
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
}

impl Default for ServeConfig {
    fn default() -> Self {
        Self {
            bind_addr: "0.0.0.0:7000".parse().expect("static addr"),
            session_ttl_secs: None,
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
/// | `/api/auth/*`      | No            | Session issue/revoke               |
/// | `/api/*`           | Yes           | App API (workspace-scoped)         |
/// | `/studio/*`        | Yes           | Control-panel API                  |
/// | `/orchestrator/*`  | Yes           | Orchestrator control endpoints     |
/// | `GET /*`           | Yes           | Static asset fallback              |
///
/// All authenticated routes use [`auth_middleware`], which validates the
/// session token and injects an [`AuthContext`] extension.
pub fn build_router(pool: PgPool, cfg: &ServeConfig) -> Router {
    use axum::middleware;

    let session_store = sf_auth::SessionStore::new(pool.clone(), cfg.session_ttl_secs);
    let state = AppState::new(pool, session_store);

    // Public auth routes — no session required.
    let auth_routes = routes::auth::router(state.clone());

    // Protected routes — all require a valid session.
    let protected = Router::new()
        .merge(routes::api::router(state.clone()))
        .merge(routes::studio::router(state.clone()))
        .merge(routes::orchestrator::router(state.clone()))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ));

    Router::new()
        .merge(auth_routes)
        .merge(protected)
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
