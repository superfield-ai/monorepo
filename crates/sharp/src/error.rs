//! Error types for the Sharp crate — VCS core, semantic merge, and analysis.
//!
//! See `docs/architecture.md` §Sharp schema and §Sharp subsystem.

use thiserror::Error;

/// Errors that can be returned by Sharp operations.
#[derive(Debug, Error)]
pub enum SharpError {
    // ── VCS core errors ───────────────────────────────────────────────────────
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

    // ── Git interop errors ───────────────────────────────────────────────────
    /// A Git interoperability error (import or export).
    #[error("git interop error: {0}")]
    GitInterop(String),

    // ── Semantic merge errors ─────────────────────────────────────────────────
    /// The rust-analyzer subprocess could not be spawned or communicated with.
    #[error("rust-analyzer subprocess error: {0}")]
    RustAnalyzerProcess(String),

    /// A JSON-RPC message could not be serialized or deserialized.
    #[error("JSON-RPC protocol error: {0}")]
    Protocol(String),

    /// The LSP request timed out waiting for a response.
    #[error("LSP request timed out after {timeout_ms}ms for method '{method}'")]
    Timeout { method: String, timeout_ms: u64 },

    /// The cargo check command failed, indicating the merge would not compile.
    #[error("cargo check failed: {0}")]
    CargoCheckFailed(String),

    /// The cargo check subprocess could not be spawned or communicated with.
    #[error("cargo check process error: {0}")]
    CargoCheckProcess(String),

    /// A merge was refused because it would produce non-compiling output.
    #[error("merge refused: non-compiling result detected\n{diagnostics}")]
    MergeRefused { diagnostics: String },

    /// I/O error.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}
