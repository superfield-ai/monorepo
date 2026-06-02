//! Pluggable transport layer for shipping build artefacts to a target.
//!
//! [`DeployTransport`] is an object-safe trait so callers can inject a
//! [`StubTransport`] in integration tests without any real network or cluster
//! access.
//!
//! [`RollbackTransport`] extends the transport surface with a [`rollback()`]
//! method that restores the prior version on the target.
//!
//! # Extension points
//!
//! - `SshTransport` — real SSH/SCP implementation (future).
//! - `KubernetesTransport` — real kubectl/rollout implementation (future).

use crate::{BuildArtifact, DeployError, TargetConfig};

/// Object-safe transport interface for shipping a build artefact.
///
/// Implementors are responsible for the actual I/O: copying a file over SSH,
/// pushing an image to a registry, calling `kubectl set image`, etc.
pub trait DeployTransport {
    /// Ship `artifact` to `config`'s target.
    ///
    /// Called after [`TargetConfig::validate()`] has already returned `Ok`.
    /// The transport must NOT re-validate the config — it can assume all
    /// required fields are present.
    fn ship(&self, config: &TargetConfig, artifact: &BuildArtifact) -> Result<(), DeployError>;
}

/// Object-safe transport interface for rolling back to the prior version.
///
/// Rollback is a separate trait because not every transport is capable of it
/// (e.g. a one-shot artifact copy has no "prior version" concept). Callers
/// that require rollback capability accept `&dyn RollbackTransport`.
pub trait RollbackTransport {
    /// Restore the prior version on `config`'s target.
    ///
    /// The semantics are transport-specific:
    /// - SSH/bare-metal: swap the active symlink / restart the prior binary.
    /// - Kubernetes: `kubectl rollout undo`.
    ///
    /// Returns the human-readable identifier of the version that was restored
    /// (e.g. an image digest or a file path).
    fn rollback(&self, config: &TargetConfig) -> Result<String, DeployError>;
}

// ── Stub transport ────────────────────────────────────────────────────────────

/// In-memory stub transport for integration tests.
///
/// Records every [`ship()`] and [`rollback()`] call so tests can assert that
/// the deploy/rollback paths are exercised without performing any real I/O.
///
/// # Example
///
/// ```rust
/// # use sf_deploy::{TargetConfig, BuildArtifact, deploy};
/// # use sf_deploy::transport::StubTransport;
/// # use std::path::PathBuf;
/// let transport = StubTransport::new();
/// let config = TargetConfig::stub("test");
/// let artifact = BuildArtifact {
///     path: std::env::current_exe().unwrap(), // any existing path
///     name: "superfield".to_string(),
/// };
/// let result = deploy(&config, &artifact, &transport).unwrap();
/// assert_eq!(transport.ship_count(), 1);
/// assert_eq!(result.target, "test");
/// ```
pub struct StubTransport {
    ship_calls: std::sync::atomic::AtomicUsize,
    rollback_calls: std::sync::atomic::AtomicUsize,
    /// When set, [`ship()`] returns this error instead of succeeding.
    pub force_error: Option<String>,
    /// Label returned by [`rollback()`] to simulate the restored version.
    pub rollback_version: Option<String>,
}

impl StubTransport {
    /// Create a new stub transport that always succeeds.
    pub fn new() -> Self {
        Self {
            ship_calls: std::sync::atomic::AtomicUsize::new(0),
            rollback_calls: std::sync::atomic::AtomicUsize::new(0),
            force_error: None,
            rollback_version: None,
        }
    }

    /// Create a stub transport that always returns a transport error.
    pub fn failing(message: impl Into<String>) -> Self {
        Self {
            ship_calls: std::sync::atomic::AtomicUsize::new(0),
            rollback_calls: std::sync::atomic::AtomicUsize::new(0),
            force_error: Some(message.into()),
            rollback_version: None,
        }
    }

    /// Number of times [`ship()`] has been called.
    pub fn ship_count(&self) -> usize {
        self.ship_calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Number of times [`rollback()`] has been called.
    pub fn rollback_count(&self) -> usize {
        self.rollback_calls
            .load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Default for StubTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl DeployTransport for StubTransport {
    fn ship(&self, _config: &TargetConfig, _artifact: &BuildArtifact) -> Result<(), DeployError> {
        self.ship_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(msg) = &self.force_error {
            return Err(DeployError::Transport(msg.clone()));
        }
        Ok(())
    }
}

impl RollbackTransport for StubTransport {
    fn rollback(&self, _config: &TargetConfig) -> Result<String, DeployError> {
        self.rollback_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(msg) = &self.force_error {
            return Err(DeployError::Transport(msg.clone()));
        }
        let version = self
            .rollback_version
            .clone()
            .unwrap_or_else(|| "prior-version".to_string());
        Ok(version)
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TargetConfig;

    fn dummy_artifact() -> BuildArtifact {
        BuildArtifact {
            // Use the test binary path — guaranteed to exist.
            path: std::env::current_exe().unwrap(),
            name: "superfield".to_string(),
        }
    }

    #[test]
    fn stub_transport_records_ship_calls() {
        let t = StubTransport::new();
        let cfg = TargetConfig::stub("test");
        let art = dummy_artifact();
        t.ship(&cfg, &art).unwrap();
        t.ship(&cfg, &art).unwrap();
        assert_eq!(t.ship_count(), 2);
    }

    #[test]
    fn failing_stub_returns_transport_error() {
        let t = StubTransport::failing("network unreachable");
        let cfg = TargetConfig::stub("test");
        let art = dummy_artifact();
        let err = t.ship(&cfg, &art).unwrap_err();
        assert!(matches!(err, DeployError::Transport(_)));
    }

    #[test]
    fn stub_rollback_records_calls_and_returns_default_version() {
        let t = StubTransport::new();
        let cfg = TargetConfig::stub("test");
        let version = t.rollback(&cfg).unwrap();
        assert_eq!(t.rollback_count(), 1);
        assert_eq!(version, "prior-version");
    }

    #[test]
    fn stub_rollback_returns_configured_version() {
        let mut t = StubTransport::new();
        t.rollback_version = Some("v1.2.3".to_string());
        let cfg = TargetConfig::stub("test");
        let version = t.rollback(&cfg).unwrap();
        assert_eq!(version, "v1.2.3");
        assert_eq!(t.rollback_count(), 1);
    }

    #[test]
    fn failing_stub_rollback_returns_transport_error() {
        let t = StubTransport::failing("rollback not available");
        let cfg = TargetConfig::stub("test");
        let err = t.rollback(&cfg).unwrap_err();
        assert!(matches!(err, DeployError::Transport(_)));
        // rollback_count is still incremented before the error check
        assert_eq!(t.rollback_count(), 1);
    }
}
