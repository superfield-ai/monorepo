//! Postgres container provisioner seam.
//!
//! Defines the [`PostgresProvisioner`] trait, which abstracts the lifecycle of
//! the local Postgres container used by the Superfield daemon. The daemon
//! (issue #489) owns the real implementation; this stub lets all phase crates
//! compile and tests pass without a live Docker socket.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Daemon Lifecycle — authoritative design for the
//!   daemon-owned Postgres container start/stop/health-gate sequence.
//! - `docs/milestone-1.md` §4.2 — daemon startup handshake contract.
//!
//! # Seam contract
//!
//! The daemon calls [`PostgresProvisioner::start`] on startup, waits for the
//! health gate, runs migrations, and only then responds with `StartupResult::Ok`
//! over the startup-notify socket. On graceful shutdown the daemon calls
//! [`PostgresProvisioner::stop`] after the gardening loop has drained.
//!
//! Component crates and tests that do not own provisioning use
//! [`TestProvisioner`] — a no-op that returns `Ok(())` immediately.
//!
//! # Implementation path (issue #489)
//!
//! The real implementation will:
//! 1. Check for a running container via the Docker socket / `docker inspect`.
//! 2. Start the container with a durable local volume if absent.
//! 3. Poll `pg_isready` until the health gate passes (max 60 s).
//! 4. Return `Ok(())` so the daemon can invoke the migration runner.
//!
//! See `docs/architecture.md` §Daemon Lifecycle for the full start/stop
//! sequence and the `~/.superfield/daemon/` state directory layout.

use std::future::Future;
use std::pin::Pin;

/// Boxed future alias used by [`PostgresProvisioner`] trait methods.
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Error type for [`PostgresProvisioner`] operations.
///
/// Extended by issue #489 to cover Docker socket errors, timeout, and
/// `pg_isready` failures.
#[derive(Debug, thiserror::Error)]
pub enum ProvisionerError {
    /// The Postgres container could not be started or stopped.
    #[error("postgres container error: {0}")]
    Container(String),

    /// The health gate timed out before Postgres accepted connections.
    #[error("postgres health-gate timeout after {0}s")]
    HealthTimeout(u64),

    /// A lower-level I/O or database error.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Seam interface for starting and stopping the local Postgres container.
///
/// The daemon (issue #489) provides a real implementation that manages a
/// Docker container with a durable local volume. Tests and crates that do not
/// own the container lifecycle use [`TestProvisioner`].
///
/// # Required interface
///
/// - [`start`] — ensure the Postgres container is running and healthy.
/// - [`stop`] — stop the container cleanly (after the loop has drained).
pub trait PostgresProvisioner: Send + Sync {
    /// Ensure the Postgres container is running and the health gate has passed.
    ///
    /// Returns `Ok(())` when Postgres is accepting connections and is ready for
    /// the migration runner. Returns [`ProvisionerError`] if the container
    /// cannot be started or the health gate times out.
    ///
    /// Idempotent: calling `start` when the container is already running is
    /// a no-op (returns `Ok(())`).
    fn start(&self) -> BoxFuture<'_, Result<(), ProvisionerError>>;

    /// Stop the Postgres container cleanly.
    ///
    /// Called by the daemon after the gardening loop has drained (via
    /// [`crate::loop_handle::LoopHandle::drain`]). A clean stop flushes WAL,
    /// closes connections, and halts the container so the durable volume
    /// remains consistent.
    ///
    /// Idempotent: calling `stop` when the container is already stopped returns
    /// `Ok(())`.
    fn stop(&self) -> BoxFuture<'_, Result<(), ProvisionerError>>;
}

// ---------------------------------------------------------------------------
// TestProvisioner — no-op stub for tests and phase compilation
// ---------------------------------------------------------------------------

/// No-op implementation of [`PostgresProvisioner`] for tests and stub wiring.
///
/// Both [`start`] and [`stop`] return `Ok(())` immediately without touching
/// Docker or any network socket. This satisfies the seam in all phase crates
/// while issue #489 implements the real container lifecycle.
///
/// # Usage
///
/// ```rust,no_run
/// use sf_db::provisioner::TestProvisioner;
/// use sf_db::provisioner::PostgresProvisioner;
///
/// # async fn example() {
/// let p = TestProvisioner;
/// assert!(p.start().await.is_ok());
/// assert!(p.stop().await.is_ok());
/// # }
/// ```
pub struct TestProvisioner;

impl PostgresProvisioner for TestProvisioner {
    fn start(&self) -> BoxFuture<'_, Result<(), ProvisionerError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<'_, Result<(), ProvisionerError>> {
        Box::pin(async { Ok(()) })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_provisioner_start_returns_ok() {
        let p = TestProvisioner;
        assert!(p.start().await.is_ok());
    }

    #[tokio::test]
    async fn test_provisioner_stop_returns_ok() {
        let p = TestProvisioner;
        assert!(p.stop().await.is_ok());
    }

    #[tokio::test]
    async fn test_provisioner_start_stop_idempotent() {
        let p = TestProvisioner;
        // Both calls should succeed — the no-op is idempotent by construction.
        assert!(p.start().await.is_ok());
        assert!(p.start().await.is_ok());
        assert!(p.stop().await.is_ok());
        assert!(p.stop().await.is_ok());
    }
}
