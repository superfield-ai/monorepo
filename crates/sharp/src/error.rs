//! Error types for the Sharp VCS core.
//!
//! See `docs/architecture.md` §Sharp schema.

use thiserror::Error;

/// Errors that can be returned by Sharp VCS operations.
#[derive(Debug, Error)]
pub enum SharpError {
    /// A database error from sqlx.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    /// A repo with the given name was not found.
    #[error("repo not found: {0}")]
    RepoNotFound(String),

    /// A ref with the given name was not found.
    #[error("ref not found: {0}")]
    RefNotFound(String),

    /// An object with the given sha256 was not found.
    #[error("object not found: {0}")]
    ObjectNotFound(String),

    /// An episode with the given id was not found.
    #[error("episode not found: {0}")]
    EpisodeNotFound(uuid::Uuid),

    /// An episode is in the wrong state for the requested operation.
    #[error("episode {0} is not open (state: {1})")]
    EpisodeNotOpen(uuid::Uuid, String),
}
