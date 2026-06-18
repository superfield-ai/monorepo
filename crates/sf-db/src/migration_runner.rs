//! Migration-runner seam — applies all component migrations at health-gated boot.
//!
//! Defines the [`MigrationRunner`] trait, which the daemon (issue #670) calls
//! AFTER [`crate::provisioner::PostgresProvisioner::start`] has passed the
//! Postgres health gate and BEFORE the HTTP serving layer binds its port. The
//! daemon owns the real implementation; this stub lets all phase crates compile
//! and tests pass without a live Postgres instance.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Daemon Lifecycle → "Startup-notify handshake"
//!   step 2 ("Run the migration runner against the now-live instance") and
//!   §Single-Instance Database Schema Layout (idempotent component migrations,
//!   applied in dependency order).
//!
//! # Seam contract
//!
//! The boot sequence is provision → **migrate** → serve → loop-start:
//!
//! ```text
//!   PostgresProvisioner::start()   // container up, pg_isready passes
//!        │
//!        ▼
//!   MigrationRunner::run(&pool)     // <── THIS SEAM: apply all component
//!        │                          //     migrations in dependency order
//!        ▼
//!   sf_serve::serve(pool, cfg)      // bind :7000 only after migrate succeeds
//! ```
//!
//! A migration failure MUST abort boot with an actionable, distinct error and
//! the HTTP server MUST NOT accept traffic against an unmigrated brain (issue
//! #670 acceptance criteria).
//!
//! # Stub-only — this is the dev-scout seam (issue #676)
//!
//! [`NoopMigrationRunner`] returns `Ok(())` immediately without touching the
//! pool. Issue #670 replaces it with the real runner that:
//! 1. Collects all component migration sets (Sharp, Nexum, auth, substrate, …)
//!    in dependency order.
//! 2. Applies each idempotently (`CREATE TABLE IF NOT EXISTS`, etc.) inside a
//!    transaction with an advisory lock so concurrent daemons do not race.
//! 3. Returns [`MigrationError`] on the first failure, naming the component and
//!    migration that failed.

use std::future::Future;
use std::pin::Pin;

use sqlx::PgPool;

/// Boxed future alias used by [`MigrationRunner`] trait methods.
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Error type for [`MigrationRunner`] operations.
///
/// Extended by issue #670 to name the component and the specific migration
/// file that failed, so the boot error is actionable.
#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    /// A migration statement failed to apply.
    #[error("migration failed: {0}")]
    Apply(String),

    /// The advisory lock guarding concurrent migration could not be acquired.
    #[error("could not acquire migration lock")]
    LockUnavailable,

    /// A lower-level database error from the underlying driver.
    #[error("database error: {0}")]
    Database(String),
}

/// Seam interface for applying all component migrations at boot.
///
/// The daemon (issue #670) provides a real implementation that applies every
/// component's migration set in dependency order against the live pool. Tests
/// and crates that do not own migration timing use [`NoopMigrationRunner`].
///
/// # Required interface
///
/// - [`run`] — apply all pending migrations against `pool`; return `Ok(())`
///   only when the schema is fully migrated and ready to serve.
pub trait MigrationRunner: Send + Sync {
    /// Apply all pending component migrations against `pool`.
    ///
    /// Called by the daemon boot path after the Postgres health gate passes
    /// and before the HTTP server binds. Returns `Ok(())` when every component
    /// migration has been applied (idempotently) and the brain is ready for
    /// traffic. Returns [`MigrationError`] on the first failure; the daemon
    /// surfaces this as a distinct boot error and exits without serving.
    ///
    /// Idempotent: re-running against an already-migrated database is a no-op
    /// that returns `Ok(())`.
    fn run<'a>(&'a self, pool: &'a PgPool) -> BoxFuture<'a, Result<(), MigrationError>>;
}

// ---------------------------------------------------------------------------
// NoopMigrationRunner — no-op stub for tests and phase compilation
// ---------------------------------------------------------------------------

/// No-op implementation of [`MigrationRunner`] for tests and stub wiring.
///
/// [`run`] returns `Ok(())` immediately without touching the pool. This
/// satisfies the seam in all phase crates while issue #670 implements the real
/// migration runner. Because it never queries `pool`, it is safe to call with
/// any pool (including one whose connection is never used).
///
/// # Usage
///
/// ```rust,no_run
/// use sf_db::migration_runner::{MigrationRunner, NoopMigrationRunner};
/// use sqlx::PgPool;
///
/// # async fn example(pool: PgPool) {
/// let runner = NoopMigrationRunner;
/// assert!(runner.run(&pool).await.is_ok());
/// # }
/// ```
pub struct NoopMigrationRunner;

impl MigrationRunner for NoopMigrationRunner {
    fn run<'a>(&'a self, _pool: &'a PgPool) -> BoxFuture<'a, Result<(), MigrationError>> {
        Box::pin(async { Ok(()) })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The no-op runner satisfies the trait object bound used by the daemon
    /// boot seam (`&dyn MigrationRunner`).
    #[test]
    fn noop_runner_is_a_migration_runner_trait_object() {
        let runner = NoopMigrationRunner;
        let _as_dyn: &dyn MigrationRunner = &runner;
    }

    /// `MigrationError` renders an actionable message for each variant so the
    /// daemon boot error surface (issue #670) is human-readable.
    #[test]
    fn migration_error_messages_are_actionable() {
        assert_eq!(
            MigrationError::Apply("0003_page_revisions".into()).to_string(),
            "migration failed: 0003_page_revisions"
        );
        assert_eq!(
            MigrationError::LockUnavailable.to_string(),
            "could not acquire migration lock"
        );
        assert_eq!(
            MigrationError::Database("connection reset".into()).to_string(),
            "database error: connection reset"
        );
    }
}
