//! Superfield deploy orchestration.
//!
//! Provisions and ships a build to a configured target environment. The crate
//! is intentionally self-contained and does not talk to Postgres directly —
//! callers thread a validated [`TargetConfig`] in and receive a
//! [`DeployResult`] back.
//!
//! # Architecture
//!
//! See `docs/architecture.md` §5 (CLI, deploy tooling, and serving backend in
//! Rust). Deploy tooling goes in `crates/sf-deploy`; the single binary
//! `superfield` mounts it via `sf_deploy::deploy()`.
//!
//! # Scope (issue #379)
//!
//! In scope:
//! - Target configuration types and pre-deploy validation
//! - [`deploy()`] — ships a build artifact to the target
//! - Dry-run / stub transport for integration tests without real infra
//!
//! Out of scope:
//! - Rollback orchestration
//! - Runtime-signal capture

pub mod config;
pub mod error;
pub mod transport;

pub use config::{TargetConfig, TargetKind};
pub use error::DeployError;
pub use transport::DeployTransport;

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
}

/// Validate `config`, then ship `artifact` to the target using `transport`.
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

    // 3. Delegate actual shipping to the transport.
    transport.ship(config, artifact)?;

    Ok(DeployResult {
        target: config.name.clone(),
        summary: format!(
            "deployed {} → {}",
            artifact.name, config.name
        ),
    })
}
