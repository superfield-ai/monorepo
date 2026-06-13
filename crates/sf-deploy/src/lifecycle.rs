//! Deployment lifecycle state machine.
//!
//! A deployment progresses through a well-defined set of states. The state is
//! tracked in a [`DeploymentRecord`] which is the authoritative checkpoint for
//! rollback and supersession decisions.
//!
//! # State diagram
//!
//! ```text
//! Pending ──deploy()──► Live
//!   Live ──rollback()──► RolledBack
//!   Live ──next deploy──► Superseded
//! ```
//!
//! # Architecture
//!
//! See `docs/architecture.md` §CLI — Command Surface. Lifecycle state lives in
//! `crates/sf-deploy`; the single binary
//! `superfield` surfaces it via the deploy subcommand.
//!
//! # Scope (issue #380)
//!
//! In scope:
//! - [`DeploymentLifecycleState`] — canonical state enum
//! - [`DeploymentRecord`] — checkpoint persisting config + state + artifact name
//! - State-transition helpers (`to_live`, `to_rolled_back`, `to_superseded`)
//!
//! Out of scope:
//! - Runtime-error capture (issue #381)
//! - Persistent database storage of records

use crate::{BuildArtifact, TargetConfig};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Lifecycle state of a single deployment.
///
/// The states map directly to the architecture document's entity lifecycle:
/// `pending → live → rolled-back | superseded`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentLifecycleState {
    /// The deployment has been validated and queued but not yet shipped.
    Pending,
    /// The deployment has been shipped and is currently serving traffic.
    Live,
    /// The deployment was active but a rollback restored the prior version.
    RolledBack,
    /// The deployment was live but has been replaced by a newer deployment.
    Superseded,
}

/// A persistent checkpoint that ties a deployment's target config to its
/// current lifecycle state and the artifact that was shipped.
///
/// `DeploymentRecord` is the authoritative record used by [`crate::rollback()`]
/// to restore the prior version. It is [`Clone`] + [`Serialize`] so callers
/// can persist it to disk or pass it over an IPC boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentRecord {
    /// Logical name of the target this deployment was shipped to.
    pub target: String,
    /// Name of the artefact that was shipped (e.g. `"superfield"`).
    pub artifact_name: String,
    /// Snapshot of the target configuration at deploy time.
    pub config: TargetConfig,
    /// Current lifecycle state.
    pub state: DeploymentLifecycleState,
    /// Unix timestamp (seconds) when this record was created.
    pub created_at: u64,
    /// Unix timestamp (seconds) of the most recent state transition.
    pub updated_at: u64,
}

impl DeploymentRecord {
    /// Create a new record in the [`DeploymentLifecycleState::Pending`] state.
    pub fn new(config: &TargetConfig, artifact: &BuildArtifact) -> Self {
        let now = unix_now();
        Self {
            target: config.name.clone(),
            artifact_name: artifact.name.clone(),
            config: config.clone(),
            state: DeploymentLifecycleState::Pending,
            created_at: now,
            updated_at: now,
        }
    }

    /// Transition to [`DeploymentLifecycleState::Live`].
    ///
    /// Returns `self` with the updated state so callers can chain or store.
    #[must_use]
    pub fn to_live(mut self) -> Self {
        self.state = DeploymentLifecycleState::Live;
        self.updated_at = unix_now();
        self
    }

    /// Transition to [`DeploymentLifecycleState::RolledBack`].
    ///
    /// Returns `self` with the updated state.
    #[must_use]
    pub fn to_rolled_back(mut self) -> Self {
        self.state = DeploymentLifecycleState::RolledBack;
        self.updated_at = unix_now();
        self
    }

    /// Transition to [`DeploymentLifecycleState::Superseded`].
    ///
    /// Call this on the previously-live record before making a new deployment
    /// live.
    #[must_use]
    pub fn to_superseded(mut self) -> Self {
        self.state = DeploymentLifecycleState::Superseded;
        self.updated_at = unix_now();
        self
    }
}

/// Current Unix timestamp in seconds. Falls back to 0 on error (should never
/// happen in practice but avoids panicking in tests).
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── Unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_record() -> DeploymentRecord {
        let config = TargetConfig::stub("prod");
        let artifact = BuildArtifact {
            path: std::env::current_exe().unwrap(),
            name: "superfield".to_string(),
        };
        DeploymentRecord::new(&config, &artifact)
    }

    #[test]
    fn new_record_starts_pending() {
        let rec = dummy_record();
        assert_eq!(rec.state, DeploymentLifecycleState::Pending);
        assert_eq!(rec.target, "prod");
        assert_eq!(rec.artifact_name, "superfield");
    }

    #[test]
    fn pending_transitions_to_live() {
        let rec = dummy_record().to_live();
        assert_eq!(rec.state, DeploymentLifecycleState::Live);
    }

    #[test]
    fn live_transitions_to_rolled_back() {
        let rec = dummy_record().to_live().to_rolled_back();
        assert_eq!(rec.state, DeploymentLifecycleState::RolledBack);
    }

    #[test]
    fn live_transitions_to_superseded() {
        let rec = dummy_record().to_live().to_superseded();
        assert_eq!(rec.state, DeploymentLifecycleState::Superseded);
    }

    #[test]
    fn record_serde_round_trip() {
        let rec = dummy_record().to_live();
        let json = serde_json::to_string(&rec).unwrap();
        let restored: DeploymentRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.target, rec.target);
        assert_eq!(restored.artifact_name, rec.artifact_name);
        assert_eq!(restored.state, rec.state);
        assert_eq!(restored.created_at, rec.created_at);
    }
}
