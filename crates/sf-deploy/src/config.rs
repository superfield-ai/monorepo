//! Target configuration for Superfield deploy tooling.
//!
//! A [`TargetConfig`] describes where and how to ship a build. It is the
//! primary input to [`crate::deploy()`] and is validated before any I/O
//! occurs.
//!
//! # Configuration fields
//!
//! | Field      | Required | Description                                      |
//! |------------|----------|--------------------------------------------------|
//! | `name`     | yes      | Logical target name, e.g. `"prod"` or `"staging"`|
//! | `kind`     | yes      | Target type (see [`TargetKind`])                 |
//! | `host`     | for SSH  | Hostname or IP of the remote host                |
//! | `user`     | for SSH  | SSH login user                                   |
//! | `dest_dir` | for SSH  | Remote directory where the artefact is placed    |
//! | `namespace`| for k8s  | Kubernetes namespace                             |
//! | `image`    | for k8s  | OCI image reference to deploy                    |

use crate::DeployError;
use serde::{Deserialize, Serialize};

/// The type of target that will receive the build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    /// Ship via SSH (scp + remote exec). Used for bare-metal and VPS targets.
    Ssh,
    /// Deploy a container image to a Kubernetes cluster via `kubectl`.
    Kubernetes,
    /// In-memory stub used in integration tests — no real I/O.
    Stub,
}

/// Full configuration for a single deploy target.
///
/// Constructed from TOML/JSON config files or from the CLI `deploy` subcommand.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetConfig {
    /// Logical name for this target (e.g. `"prod"`, `"staging"`).
    pub name: String,
    /// Transport type.
    pub kind: TargetKind,

    // SSH-specific fields.
    /// Remote hostname or IP (required for [`TargetKind::Ssh`]).
    pub host: Option<String>,
    /// SSH login user (required for [`TargetKind::Ssh`]).
    pub user: Option<String>,
    /// Remote destination directory (required for [`TargetKind::Ssh`]).
    pub dest_dir: Option<String>,

    // Kubernetes-specific fields.
    /// Kubernetes namespace (required for [`TargetKind::Kubernetes`]).
    pub namespace: Option<String>,
    /// OCI image reference, e.g. `"ghcr.io/superfield-ai/superfield:0.1.0"`
    /// (required for [`TargetKind::Kubernetes`]).
    pub image: Option<String>,
}

impl TargetConfig {
    /// Construct a minimal stub target config for testing.
    pub fn stub(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind: TargetKind::Stub,
            host: None,
            user: None,
            dest_dir: None,
            namespace: None,
            image: None,
        }
    }

    /// Validate the configuration, returning [`DeployError::InvalidConfig`]
    /// if any required field for the chosen [`TargetKind`] is missing or empty.
    ///
    /// This is the single authoritative validation gate; [`crate::deploy()`]
    /// calls it before performing any I/O.
    pub fn validate(&self) -> Result<(), DeployError> {
        if self.name.trim().is_empty() {
            return Err(DeployError::InvalidConfig(
                "target name must not be empty".into(),
            ));
        }

        match self.kind {
            TargetKind::Ssh => {
                require_field(&self.host, "host", &self.name)?;
                require_field(&self.user, "user", &self.name)?;
                require_field(&self.dest_dir, "dest_dir", &self.name)?;
            }
            TargetKind::Kubernetes => {
                require_field(&self.namespace, "namespace", &self.name)?;
                require_field(&self.image, "image", &self.name)?;
            }
            TargetKind::Stub => {
                // Stub requires no extra fields — used in tests.
            }
        }

        Ok(())
    }
}

/// Helper: return `Err(InvalidConfig)` when a required `Option<String>` field
/// is `None` or empty.
fn require_field(
    field: &Option<String>,
    field_name: &str,
    target_name: &str,
) -> Result<(), DeployError> {
    match field {
        Some(v) if !v.trim().is_empty() => Ok(()),
        _ => Err(DeployError::InvalidConfig(format!(
            "target '{}': '{}' is required for this target kind",
            target_name, field_name
        ))),
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh_config(
        name: &str,
        host: Option<&str>,
        user: Option<&str>,
        dest_dir: Option<&str>,
    ) -> TargetConfig {
        TargetConfig {
            name: name.to_string(),
            kind: TargetKind::Ssh,
            host: host.map(str::to_string),
            user: user.map(str::to_string),
            dest_dir: dest_dir.map(str::to_string),
            namespace: None,
            image: None,
        }
    }

    fn k8s_config(name: &str, namespace: Option<&str>, image: Option<&str>) -> TargetConfig {
        TargetConfig {
            name: name.to_string(),
            kind: TargetKind::Kubernetes,
            host: None,
            user: None,
            dest_dir: None,
            namespace: namespace.map(str::to_string),
            image: image.map(str::to_string),
        }
    }

    #[test]
    fn stub_validates_ok() {
        TargetConfig::stub("test").validate().unwrap();
    }

    #[test]
    fn empty_name_fails() {
        let cfg = TargetConfig::stub("  ");
        let err = cfg.validate().unwrap_err();
        assert!(matches!(err, DeployError::InvalidConfig(_)));
    }

    #[test]
    fn ssh_all_fields_ok() {
        ssh_config(
            "prod",
            Some("10.0.0.1"),
            Some("deploy"),
            Some("/opt/superfield"),
        )
        .validate()
        .unwrap();
    }

    #[test]
    fn ssh_missing_host_fails() {
        let err = ssh_config("prod", None, Some("deploy"), Some("/opt/superfield"))
            .validate()
            .unwrap_err();
        assert!(matches!(err, DeployError::InvalidConfig(_)));
    }

    #[test]
    fn ssh_missing_user_fails() {
        let err = ssh_config("prod", Some("10.0.0.1"), None, Some("/opt/superfield"))
            .validate()
            .unwrap_err();
        assert!(matches!(err, DeployError::InvalidConfig(_)));
    }

    #[test]
    fn ssh_missing_dest_dir_fails() {
        let err = ssh_config("prod", Some("10.0.0.1"), Some("deploy"), None)
            .validate()
            .unwrap_err();
        assert!(matches!(err, DeployError::InvalidConfig(_)));
    }

    #[test]
    fn ssh_empty_host_fails() {
        let err = ssh_config("prod", Some("  "), Some("deploy"), Some("/opt/superfield"))
            .validate()
            .unwrap_err();
        assert!(matches!(err, DeployError::InvalidConfig(_)));
    }

    #[test]
    fn k8s_all_fields_ok() {
        k8s_config(
            "staging",
            Some("default"),
            Some("ghcr.io/superfield-ai/superfield:0.1.0"),
        )
        .validate()
        .unwrap();
    }

    #[test]
    fn k8s_missing_namespace_fails() {
        let err = k8s_config(
            "staging",
            None,
            Some("ghcr.io/superfield-ai/superfield:0.1.0"),
        )
        .validate()
        .unwrap_err();
        assert!(matches!(err, DeployError::InvalidConfig(_)));
    }

    #[test]
    fn k8s_missing_image_fails() {
        let err = k8s_config("staging", Some("default"), None)
            .validate()
            .unwrap_err();
        assert!(matches!(err, DeployError::InvalidConfig(_)));
    }
}
