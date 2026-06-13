//! Superfield deploy orchestration.
//!
//! Provisions and ships a build to a configured target environment, tracks
//! deployment lifecycle state, and supports rollback to the prior version.
//! The crate is intentionally self-contained and does not talk to Postgres
//! directly — callers thread a validated [`TargetConfig`] in and receive a
//! [`DeployResult`] back.
//!
//! # Architecture
//!
//! See `docs/architecture.md` §CLI — Command Surface. Deploy tooling goes in
//! `crates/sf-deploy`; the single binary
//! `superfield` mounts it via `sf_deploy::deploy()`.
//!
//! # Scope (issue #379 + #380)
//!
//! In scope:
//! - Target configuration types and pre-deploy validation
//! - [`deploy()`] — ships a build artifact to the target
//! - [`rollback()`] — restores the prior version on the target
//! - [`lifecycle::DeploymentLifecycleState`] and [`lifecycle::DeploymentRecord`]
//! - Dry-run / stub transport for integration tests without real infra
//!
//! Out of scope:
//! - Runtime-signal capture (issue #381)

pub mod config;
pub mod error;
pub mod lifecycle;
pub mod transport;

pub use config::{TargetConfig, TargetKind};
pub use error::DeployError;
pub use lifecycle::{DeploymentLifecycleState, DeploymentRecord};
pub use transport::{DeployTransport, RollbackTransport};

use std::path::PathBuf;

// ── Public API ────────────────────────────────────────────────────────────────

/// Artefact to be shipped to the target.
///
/// The path must point to an existing file before [`deploy()`] is called.
#[derive(Debug, Clone)]
pub struct BuildArtifact {
    /// Local filesystem path to the compiled artefact (e.g. a stripped ELF
    /// binary or a `.tar.gz` release bundle).
    pub path: PathBuf,
    /// Human-readable label used in deploy log messages (e.g. `"superfield"`).
    pub name: String,
}

/// Outcome of a successful deploy.
#[derive(Debug, Clone)]
pub struct DeployResult {
    /// Name of the target the build was shipped to.
    pub target: String,
    /// Short human-readable summary (e.g. "deployed superfield 0.1.0 → prod").
    pub summary: String,
    /// Lifecycle record after a successful deploy (state = [`DeploymentLifecycleState::Live`]).
    pub record: DeploymentRecord,
}

/// Outcome of a successful rollback.
#[derive(Debug, Clone)]
pub struct RollbackResult {
    /// Name of the target that was rolled back.
    pub target: String,
    /// Human-readable identifier of the restored version (e.g. image digest or
    /// binary path).
    pub restored_version: String,
    /// Lifecycle record after rollback (state = [`DeploymentLifecycleState::RolledBack`]).
    pub record: DeploymentRecord,
}

/// Validate `config`, then ship `artifact` to the target using `transport`.
///
/// On success the returned [`DeployResult`] contains a [`DeploymentRecord`] in
/// the [`DeploymentLifecycleState::Live`] state. Callers should persist this
/// record if they want to support [`rollback()`] without live cluster access.
///
/// Errors are returned as [`DeployError`]; no side effects occur before
/// validation passes.
///
/// # Arguments
///
/// * `config`    — validated target configuration (see [`TargetConfig::validate`]).
/// * `artifact`  — the build artefact to ship.
/// * `transport` — pluggable transport (real SSH/k8s or stub for tests).
pub fn deploy(
    config: &TargetConfig,
    artifact: &BuildArtifact,
    transport: &dyn DeployTransport,
) -> Result<DeployResult, DeployError> {
    // 1. Validate config before touching anything.
    config.validate()?;

    // 2. Verify the artefact path exists (fast-fail).
    if !artifact.path.exists() {
        return Err(DeployError::ArtifactNotFound(artifact.path.clone()));
    }

    // 3. Create a lifecycle record (Pending).
    let record = DeploymentRecord::new(config, artifact);

    // 4. Delegate actual shipping to the transport.
    transport.ship(config, artifact)?;

    // 5. Transition to Live.
    let record = record.to_live();

    Ok(DeployResult {
        target: config.name.clone(),
        summary: format!("deployed {} → {}", artifact.name, config.name),
        record,
    })
}

/// Roll back the target to its prior version using `transport`.
///
/// `prior_record` is the [`DeploymentRecord`] returned by the previous
/// [`deploy()`] call for this target. It is used to verify that the target
/// name matches and to build the returned [`RollbackResult`]. The caller is
/// responsible for supplying the correct record; this function does not
/// consult any persistent store.
///
/// On success the returned [`RollbackResult`] contains a [`DeploymentRecord`]
/// in the [`DeploymentLifecycleState::RolledBack`] state.
///
/// # Arguments
///
/// * `prior_record` — the live deployment record for the target.
/// * `transport`    — pluggable rollback transport.
pub fn rollback(
    prior_record: DeploymentRecord,
    transport: &dyn RollbackTransport,
) -> Result<RollbackResult, DeployError> {
    let config = &prior_record.config.clone();

    // Ask the transport to restore the prior version.
    let restored_version = transport.rollback(config)?;

    // Transition the record to RolledBack.
    let record = prior_record.to_rolled_back();

    Ok(RollbackResult {
        target: config.name.clone(),
        restored_version,
        record,
    })
}
