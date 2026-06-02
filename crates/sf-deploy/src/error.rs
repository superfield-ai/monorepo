//! Error types for the deploy crate.

use std::path::PathBuf;
use thiserror::Error;

/// All errors that [`crate::deploy()`] can return.
#[derive(Debug, Error)]
pub enum DeployError {
    /// One or more required configuration fields are missing or invalid.
    ///
    /// Contains a human-readable description of the problem; callers should
    /// surface this directly to the operator.
    #[error("invalid target config: {0}")]
    InvalidConfig(String),

    /// The build artefact path does not exist on disk.
    #[error("artifact not found: {0}")]
    ArtifactNotFound(PathBuf),

    /// The transport layer failed to ship the artefact.
    ///
    /// Wraps whatever lower-level error the transport reported.
    #[error("transport error: {0}")]
    Transport(String),
}
