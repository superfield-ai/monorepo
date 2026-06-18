//! Shared application state injected into axum route handlers.
//!
//! [`AppState`] is an `Arc`-wrapped struct so it is cheap to clone
//! (required for axum `State` extractors).
//!
//! # Loop-handle install seam (dev-scout issue #676)
//!
//! [`Inner`] carries an optional [`LoopHandle`](crate::loop_handle::LoopHandle)
//! trait object. The daemon boot path stores the gardening-loop handle here
//! after starting the loop, and the shutdown path retrieves it to call
//! [`drain`](crate::loop_handle::LoopHandle::drain). On the pre-#671 path the
//! field is `None` (no loop installed); issue #671 starts
//! `sf_loop::GardeningLoop` and installs the real `GardeningLoopHandle` via
//! [`AppState::with_loop_handle`]. See `docs/architecture.md` §Daemon Lifecycle.

use sf_auth::SessionStore;
use sqlx::PgPool;
use std::sync::Arc;

use crate::loop_handle::LoopHandle;
use crate::orchestrator_state::OrchestratorState;

/// Inner fields of the shared state.
///
/// Callers access this through [`AppState`] (which is `Arc<Inner>`).
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

    /// Optional handle to the running gardening loop (dev-scout seam #676).
    ///
    /// `None` on the pre-#671 boot path (no loop installed). The daemon boot
    /// path installs the real `sf_loop::GardeningLoopHandle` here via
    /// [`AppState::with_loop_handle`]; the shutdown path drains it before
    /// stopping the Postgres provisioner. Wired by issue #671.
    pub loop_handle: Option<Arc<dyn LoopHandle>>,

    /// Live orchestrator runtime state (issue #674).
    ///
    /// The observable projection of the gardening-loop lifecycle that the
    /// `/orchestrator/*` and `/analytics/*` routes serve: process state, pid,
    /// uptime, per-loop health, active work slots, and the log/CI SSE streams.
    /// Always present — a fresh [`OrchestratorState`] in `stopped` is installed
    /// by [`AppState::new`]; the daemon boot path drives its lifecycle.
    pub orchestrator: OrchestratorState,
}

impl std::fmt::Debug for Inner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Inner")
            .field("pool", &self.pool)
            .field("session_store", &self.session_store)
            .field(
                "loop_handle",
                &self.loop_handle.as_ref().map(|_| "installed"),
            )
            .field("orchestrator", &self.orchestrator)
            .finish()
    }
}

/// Shared state for all axum route handlers.
///
/// Clone is `O(1)` — this is `Arc<Inner>` under the hood.
#[derive(Debug, Clone)]
pub struct AppState(pub Arc<Inner>);

impl AppState {
    /// Build an [`AppState`] from a shared pool and a session store.
    ///
    /// No loop handle is installed (`loop_handle == None`). The daemon boot
    /// path uses [`with_loop_handle`](Self::with_loop_handle) to attach the
    /// running gardening loop (issue #671).
    pub fn new(pool: PgPool, session_store: SessionStore) -> Self {
        Self(Arc::new(Inner {
            pool,
            session_store,
            loop_handle: None,
            orchestrator: OrchestratorState::new(),
        }))
    }

    /// Build an [`AppState`] with a gardening-loop handle installed.
    ///
    /// Loop-handle install seam (dev-scout #676): the daemon boot path calls
    /// `sf_loop::GardeningLoop::start(...)` and passes the resulting handle
    /// here so the shutdown path can drain it. Wired by issue #671.
    pub fn with_loop_handle(
        pool: PgPool,
        session_store: SessionStore,
        loop_handle: Arc<dyn LoopHandle>,
    ) -> Self {
        Self(Arc::new(Inner {
            pool,
            session_store,
            loop_handle: Some(loop_handle),
            orchestrator: OrchestratorState::new(),
        }))
    }

    /// Build an [`AppState`] with a loop handle **and** a caller-supplied
    /// [`OrchestratorState`] installed.
    ///
    /// The daemon creates one [`OrchestratorState`], hands a clone to the
    /// gardening loop (which records ticks and publishes logs into it), and
    /// installs the same instance here so the `/orchestrator/*` and
    /// `/analytics/*` routes report the loop's genuinely-live state (issue
    /// #674). The session store is built from the pool and TTL.
    pub fn with_loop_handle_and_orchestrator(
        pool: PgPool,
        session_ttl_secs: Option<i64>,
        loop_handle: Arc<dyn LoopHandle>,
        orchestrator: OrchestratorState,
    ) -> Self {
        let session_store = SessionStore::new(pool.clone(), session_ttl_secs);
        Self(Arc::new(Inner {
            pool,
            session_store,
            loop_handle: Some(loop_handle),
            orchestrator,
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

    /// Access the installed gardening-loop handle, if any.
    ///
    /// Returns `None` on the pre-#671 boot path. The daemon shutdown path uses
    /// this to call [`drain`](crate::loop_handle::LoopHandle::drain) before
    /// stopping the Postgres provisioner.
    pub fn loop_handle(&self) -> Option<&Arc<dyn LoopHandle>> {
        self.0.loop_handle.as_ref()
    }

    /// Access the live orchestrator runtime state (issue #674).
    ///
    /// The `/orchestrator/*` and `/analytics/*` routes read process/loop/slot
    /// state and the log/CI SSE streams from here; the daemon boot path drives
    /// its lifecycle.
    pub fn orchestrator(&self) -> &OrchestratorState {
        &self.0.orchestrator
    }
}
