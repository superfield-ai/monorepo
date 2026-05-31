//! Shared application state injected into axum route handlers.
//!
//! [`AppState`] is an `Arc`-wrapped struct so it is cheap to clone
//! (required for axum `State` extractors).

use sf_auth::SessionStore;
use sqlx::PgPool;
use std::sync::Arc;

/// Inner fields of the shared state.
///
/// Callers access this through [`AppState`] (which is `Arc<Inner>`).
#[derive(Debug)]
pub struct Inner {
    /// The shared Postgres connection pool.
    ///
    /// One pool for the entire binary; component crates receive it rather
    /// than opening their own pools.  See `docs/architecture.md`
    /// §Single-Instance Database Schema Layout.
    pub pool: PgPool,

    /// Handle to the `auth.sessions` table.
    ///
    /// Used by the auth middleware and the `/api/auth/*` routes.
    pub session_store: SessionStore,
}

/// Shared state for all axum route handlers.
///
/// Clone is `O(1)` — this is `Arc<Inner>` under the hood.
#[derive(Debug, Clone)]
pub struct AppState(pub Arc<Inner>);

impl AppState {
    /// Build an [`AppState`] from a shared pool and a session store.
    pub fn new(pool: PgPool, session_store: SessionStore) -> Self {
        Self(Arc::new(Inner {
            pool,
            session_store,
        }))
    }

    /// Access the inner pool.
    pub fn pool(&self) -> &PgPool {
        &self.0.pool
    }

    /// Access the inner session store.
    pub fn session_store(&self) -> &SessionStore {
        &self.0.session_store
    }
}
