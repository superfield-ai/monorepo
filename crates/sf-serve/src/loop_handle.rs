//! Daemon loop-handle seam — drain and abort interface for the gardening loop.
//!
//! Defines the [`LoopHandle`] trait, which the daemon (issue #489) uses to
//! control the gardening loop engine (issue #491) during graceful shutdown and
//! on version-mismatch restart.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Daemon Lifecycle — drain/abort contract.
//! - `docs/milestone-1.md` §4.2 — startup-notify handshake (drain precedes stop).
//!
//! # Seam contract
//!
//! ```text
//!  CLI  ──"daemon stop"──▶  daemon  ──drain()──▶  loop engine
//!                                 ◀──Ok(())────────────────
//!                           stop Postgres
//!                           exit 0
//! ```
//!
//! On graceful shutdown the daemon:
//! 1. Calls [`LoopHandle::drain`] and awaits it (the loop finishes its current
//!    gardening step and then stops accepting new steps).
//! 2. Calls [`PostgresProvisioner::stop`] (see `sf_db::provisioner`).
//! 3. Exits with code 0.
//!
//! On abort (e.g. SIGKILL imminent) the daemon calls [`LoopHandle::abort`],
//! which cancels any in-flight step immediately.

use std::future::Future;
use std::pin::Pin;

/// Boxed future alias used by [`LoopHandle`] trait methods.
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Error type for [`LoopHandle`] operations.
#[derive(Debug, thiserror::Error)]
pub enum LoopHandleError {
    /// The loop task has already exited or was never started.
    #[error("loop task not running")]
    NotRunning,

    /// The drain signal could not be delivered.
    #[error("drain channel closed")]
    DrainChannelClosed,
}

/// Seam interface for controlling the gardening loop engine from the daemon.
///
/// The gardening loop engine (issue #491) provides the real implementation.
/// Tests and crates that do not own the loop task use [`NoopLoopHandle`].
///
/// # Required interface
///
/// - [`drain`] — finish the current gardening step, then stop.
/// - [`abort`] — cancel any in-flight step immediately.
pub trait LoopHandle: Send + Sync {
    /// Signal the gardening loop to finish its current step and then stop.
    ///
    /// Returns `Ok(())` when the loop has stopped cleanly. The caller (daemon
    /// shutdown path) should impose an external timeout and fall back to
    /// [`abort`] if this future does not resolve within the timeout.
    ///
    /// # Errors
    ///
    /// Returns [`LoopHandleError::DrainChannelClosed`] if the loop task has
    /// already exited. Returns [`LoopHandleError::NotRunning`] if no loop was
    /// ever started.
    fn drain(&self) -> BoxFuture<'_, Result<(), LoopHandleError>>;

    /// Cancel any in-flight gardening step immediately.
    ///
    /// Used when the daemon needs to exit without waiting for the current step
    /// to complete (e.g. SIGKILL imminent, forced restart).
    ///
    /// # Errors
    ///
    /// Returns [`LoopHandleError::NotRunning`] if the loop task is not running.
    fn abort(&self) -> BoxFuture<'_, Result<(), LoopHandleError>>;
}

// ---------------------------------------------------------------------------
// NoopLoopHandle — no-op stub for tests and phase compilation
// ---------------------------------------------------------------------------

/// No-op implementation of [`LoopHandle`] for tests and stub wiring.
///
/// Both [`drain`] and [`abort`] return `Ok(())` immediately without touching
/// any task or channel. This satisfies the seam in all phase crates while
/// issue #491 implements the real loop engine.
///
/// # Usage
///
/// ```rust,no_run
/// use sf_serve::loop_handle::{LoopHandle, NoopLoopHandle};
///
/// # async fn example() {
/// let handle = NoopLoopHandle;
/// assert!(handle.drain().await.is_ok());
/// assert!(handle.abort().await.is_ok());
/// # }
/// ```
pub struct NoopLoopHandle;

impl LoopHandle for NoopLoopHandle {
    fn drain(&self) -> BoxFuture<'_, Result<(), LoopHandleError>> {
        Box::pin(async { Ok(()) })
    }

    fn abort(&self) -> BoxFuture<'_, Result<(), LoopHandleError>> {
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
    async fn noop_drain_returns_ok() {
        let h = NoopLoopHandle;
        assert!(h.drain().await.is_ok());
    }

    #[tokio::test]
    async fn noop_abort_returns_ok() {
        let h = NoopLoopHandle;
        assert!(h.abort().await.is_ok());
    }

    #[tokio::test]
    async fn noop_drain_abort_idempotent() {
        let h = NoopLoopHandle;
        // Both operations are idempotent no-ops in the stub.
        assert!(h.drain().await.is_ok());
        assert!(h.drain().await.is_ok());
        assert!(h.abort().await.is_ok());
        assert!(h.abort().await.is_ok());
    }
}
