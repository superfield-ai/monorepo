//! Deploy-operator CLI commands.
//!
//! These commands mirror the TypeScript `deploy-env`, `rollback-env`, and
//! `doctor` subcommands from `packages/cli/commands/`.  They are backed
//! entirely by [`sf_deploy`] (config validation + [`sf_deploy::transport`])
//! without requiring any TypeScript/Node runtime, GCP SDK, or GitHub client.
//!
//! # Commands
//!
//! - **`deploy-env`** — validate a target config JSON and run a deploy via the
//!   pluggable transport.  In this stub the transport is
//!   [`sf_deploy::transport::StubTransport`]; a real SSH/k8s transport ships in
//!   a later issue.
//! - **`rollback-env`** — roll back the target to its prior version using a
//!   serialised [`sf_deploy::DeploymentRecord`].
//! - **`doctor`** — run preflight validation on a target config and report any
//!   missing required fields.
//!
//! # Architecture
//!
//! See `docs/architecture.md` §CLI — Command Surface (deploy subcommands) and
//! §Daemon Lifecycle (auto-spawn flow).  Deploy-ops commands live here rather than in
//! `operator.rs` to keep the operator module focused on Sharp repo/session
//! management.

use sf_deploy::{config::TargetConfig, transport::StubTransport, DeploymentRecord};
use std::path::PathBuf;
use thiserror::Error;

/// Errors from deploy-operator commands.
#[derive(Debug, Error)]
pub enum DeployOpsError {
    /// A deploy or rollback error from `sf-deploy`.
    #[error("deploy error: {0}")]
    Deploy(#[from] sf_deploy::DeployError),

    /// JSON parse error (bad config or record JSON).
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// A required argument or environment variable is missing.
    #[error("{0}")]
    Usage(String),
}

// ── deploy-env ────────────────────────────────────────────────────────────────

/// Run a deploy against the target described by `config_json`.
///
/// Validates the config, then ships the artifact at `artifact_path` using the
/// [`StubTransport`].  A real SSH/k8s transport will be substituted in a
/// subsequent issue once the transport impls ship.
///
/// # Output
///
/// Prints a one-line deploy summary to stdout on success.
pub fn deploy_env(config_json: &str, artifact_path: &str) -> Result<(), DeployOpsError> {
    let config: TargetConfig = serde_json::from_str(config_json)?;

    let artifact = sf_deploy::BuildArtifact {
        path: PathBuf::from(artifact_path),
        name: config.name.clone(),
    };

    let transport = StubTransport::new();
    let result = sf_deploy::deploy(&config, &artifact, &transport)?;
    println!("{}", result.summary);
    Ok(())
}

// ── rollback-env ──────────────────────────────────────────────────────────────

/// Roll back a target to its prior version using a serialised
/// [`DeploymentRecord`].
///
/// The record JSON must have been produced by a previous `deploy-env` call.
/// Uses [`StubTransport`] as the rollback transport (real implementation in a
/// subsequent issue).
///
/// # Output
///
/// Prints `rolled back <target> → <restored-version>` to stdout on success.
pub fn rollback_env(record_json: &str) -> Result<(), DeployOpsError> {
    let record: DeploymentRecord = serde_json::from_str(record_json)?;
    let target = record.config.name.clone();

    let transport = StubTransport::new();
    let result = sf_deploy::rollback(record, &transport)?;
    println!("rolled back {} → {}", target, result.restored_version);
    Ok(())
}

// ── doctor ────────────────────────────────────────────────────────────────────

/// Run preflight validation on a target config JSON.
///
/// Validates all required fields for the chosen target kind and prints the
/// result.  Exits cleanly with a summary — does not perform any network I/O.
///
/// # Output
///
/// Prints `ok: <target-name>` on success, or a list of validation errors on
/// failure (returns [`DeployOpsError::Deploy`]).
pub fn doctor(config_json: &str) -> Result<(), DeployOpsError> {
    let config: TargetConfig = serde_json::from_str(config_json)?;
    config.validate()?;
    println!("ok: {}", config.name);
    Ok(())
}

// ── unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn stub_config_json(name: &str) -> String {
        format!(r#"{{"name":"{name}","kind":"stub"}}"#)
    }

    #[test]
    fn doctor_stub_config_passes() {
        doctor(&stub_config_json("test")).unwrap();
    }

    #[test]
    fn doctor_invalid_ssh_config_fails() {
        // SSH config with missing host/user/dest_dir.
        let json = r#"{"name":"prod","kind":"ssh"}"#;
        let err = doctor(json).unwrap_err();
        assert!(matches!(err, DeployOpsError::Deploy(_)));
    }

    #[test]
    fn doctor_bad_json_returns_json_error() {
        let err = doctor("not-json").unwrap_err();
        assert!(matches!(err, DeployOpsError::Json(_)));
    }

    #[test]
    fn rollback_env_bad_json_returns_json_error() {
        let err = rollback_env("not-json").unwrap_err();
        assert!(matches!(err, DeployOpsError::Json(_)));
    }
}
