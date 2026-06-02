//! Sharp component — git objects and code-intelligence.
//!
//! # Dev-scout spike: rust-analyzer-backed semantic merge
//!
//! This module contains a **stub-only** prototype of the rust-analyzer
//! subprocess orchestration layer required for semantic merging in the Sharp
//! component.  No real LSP communication is performed here; the stubs define
//! the public API surface and record feasibility findings as inline comments.
//!
//! ## Approach (spike findings)
//!
//! 1. **Subprocess orchestration** — rust-analyzer is spawned as a child
//!    process communicating over stdin/stdout using the Language Server
//!    Protocol (LSP) JSON-RPC transport.  The `lsp-types` crate provides
//!    message types without imposing a specific async runtime.
//!
//! 2. **Rename enumeration** — `textDocument/rename` requests drive
//!    workspace-wide rename discovery.  The response carries `WorkspaceEdit`
//!    with all affected `TextEdit` locations, which the merge engine uses to
//!    detect semantic rename conflicts across a three-way merge base.
//!
//! 3. **Structural verification** — after applying rename edits the spike
//!    shells out to `cargo check --message-format=json` and parses
//!    `compiler-message` lines.  Zero error-level diagnostics confirms that
//!    the structural merge is semantically valid.
//!
//! ## Latency findings (stub — to be filled on real run)
//!
//! | Operation                | Observed (stub) | Notes                          |
//! |--------------------------|-----------------|--------------------------------|
//! | rust-analyzer cold start | N/A             | Expected ~3–8 s for mid crate  |
//! | rename enumeration       | N/A             | Expected <500 ms warm          |
//! | cargo check              | N/A             | Expected ~2–10 s cold          |
//!
//! ## Failure modes
//!
//! - **rust-analyzer not on PATH** — `AnalyzerError::SpawnFailed`; callers
//!   should surface a human-readable install hint.
//! - **LSP initialisation timeout** — rust-analyzer can take >10 s on large
//!   workspaces; the spike must cap with a configurable deadline.
//! - **Stale index** — if the workspace has never been built, rust-analyzer
//!   may produce empty or incorrect rename results; `cargo check` catches this.
//! - **Macro-generated identifiers** — rename requests on proc-macro output
//!   sites return empty edit sets; the merge engine must fall back to
//!   text-diff in that case.
//!
//! ## Integration seam
//!
//! Mount via `superfield::mount_sharp()` in the binary entrypoint once this
//! component provides its service interface.
//!
//! ## Risk assessment
//!
//! **Feasibility:** High.  rust-analyzer exposes a stable LSP surface; the
//! JSON-RPC protocol is well-documented and `lsp-types` covers it completely.
//!
//! **Primary risk:** Cold-start latency.  A persistent daemon mode (keep the
//! rust-analyzer process alive across merges) is the mitigation; the stub API
//! already models this with the `RustAnalyzer` session object.
//!
//! **Secondary risk:** Macro rename gaps.  Out of scope for this spike; a
//! fallback to structural text-diff is the accepted degradation path.

use std::path::PathBuf;

use thiserror::Error;

// ── Error type ────────────────────────────────────────────────────────────────

/// Errors produced by the rust-analyzer orchestration layer.
#[derive(Debug, Error)]
pub enum AnalyzerError {
    /// The `rust-analyzer` binary could not be spawned.  Typically means it is
    /// not installed or not on `PATH`.
    #[error("failed to spawn rust-analyzer: {0}")]
    SpawnFailed(String),

    /// The LSP `initialize` handshake did not complete within the deadline.
    #[error("rust-analyzer initialisation timed out after {timeout_ms} ms")]
    InitTimeout { timeout_ms: u64 },

    /// An LSP request/response cycle failed.
    #[error("LSP protocol error: {0}")]
    LspProtocol(String),

    /// `cargo check` reported one or more error-level diagnostics after
    /// applying the rename edits, indicating an invalid structural merge.
    #[error("cargo check failed with {error_count} error(s) after merge")]
    CargoCheckFailed { error_count: usize },

    /// The workspace path does not exist or is not a Cargo workspace root.
    #[error("invalid workspace path: {0}")]
    InvalidWorkspace(PathBuf),
}

// ── Domain types ──────────────────────────────────────────────────────────────

/// A single rename discovered by rust-analyzer across the workspace.
///
/// Each `RenameEdit` maps a source location to its replacement text.  The
/// merge engine compares these against the opposing branch's edits to detect
/// semantic rename conflicts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameEdit {
    /// Workspace-relative path of the file containing the rename site.
    pub file: PathBuf,
    /// 0-based line of the identifier being renamed.
    pub line: u32,
    /// 0-based start column of the identifier.
    pub col_start: u32,
    /// 0-based exclusive end column of the identifier.
    pub col_end: u32,
    /// The replacement text rust-analyzer proposes.
    pub new_text: String,
}

/// Summary of a `cargo check` pass over a post-merge workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckResult {
    /// Number of compiler error diagnostics emitted.
    pub error_count: usize,
    /// Number of compiler warning diagnostics emitted.
    pub warning_count: usize,
    /// Raw `rustc` messages in JSON format (one per line).
    pub raw_messages: Vec<String>,
}

impl CheckResult {
    /// Returns `true` when the workspace compiled without errors.
    pub fn is_clean(&self) -> bool {
        self.error_count == 0
    }
}

// ── rust-analyzer session (stub) ──────────────────────────────────────────────

/// A long-lived rust-analyzer subprocess session.
///
/// Construct once per workspace via [`RustAnalyzer::init`] and reuse across
/// rename-enumeration and verification calls to amortise the cold-start cost.
///
/// **Stub:** all methods return `Err(AnalyzerError::SpawnFailed(...))` with a
/// message indicating the production implementation is pending.  The public
/// surface is intentionally complete so that call-sites can be written against
/// it before the real LSP plumbing lands.
#[derive(Debug)]
pub struct RustAnalyzer {
    workspace_root: PathBuf,
}

impl RustAnalyzer {
    /// Initialise a rust-analyzer session for `workspace_root`.
    ///
    /// Spawns the `rust-analyzer` binary, sends the LSP `initialize` request,
    /// and waits for `initialized` before returning.
    ///
    /// # Errors
    ///
    /// - [`AnalyzerError::SpawnFailed`] if the binary is not on `PATH`.
    /// - [`AnalyzerError::InitTimeout`] if initialisation exceeds `timeout_ms`.
    /// - [`AnalyzerError::InvalidWorkspace`] if `workspace_root` is not a
    ///   Cargo workspace.
    pub fn init(workspace_root: PathBuf, _timeout_ms: u64) -> Result<Self, AnalyzerError> {
        // Stub: production implementation will spawn rust-analyzer over
        // stdin/stdout and perform the LSP initialize/initialized handshake.
        let _ = &workspace_root;
        Err(AnalyzerError::SpawnFailed(
            "stub — production LSP implementation pending (issue #369)".into(),
        ))
    }

    /// Enumerate all rename edits for the identifier at `(file, line, col)`.
    ///
    /// Sends a `textDocument/rename` LSP request and collects the returned
    /// [`WorkspaceEdit`] into a flat list of [`RenameEdit`] values.
    ///
    /// Returns an empty `Vec` when rust-analyzer finds no renameable sites
    /// (e.g. the identifier originates from a proc-macro expansion).
    ///
    /// # Errors
    ///
    /// - [`AnalyzerError::LspProtocol`] on any LSP transport failure.
    pub fn enumerate_renames(
        &self,
        file: &PathBuf,
        line: u32,
        col: u32,
        new_name: &str,
    ) -> Result<Vec<RenameEdit>, AnalyzerError> {
        // Stub: production implementation will issue textDocument/rename and
        // parse the WorkspaceEdit response from the LSP stream.
        let _ = (file, line, col, new_name, &self.workspace_root);
        Err(AnalyzerError::LspProtocol(
            "stub — production LSP implementation pending (issue #369)".into(),
        ))
    }

    /// Shut down the rust-analyzer subprocess cleanly.
    ///
    /// Sends the LSP `shutdown` + `exit` sequence and waits for the child
    /// process to terminate.
    pub fn shutdown(self) {
        // Stub: production implementation will send LSP shutdown/exit.
        let _ = self.workspace_root;
    }
}

// ── Structural verification (stub) ────────────────────────────────────────────

/// Run `cargo check` over `workspace_root` and parse the diagnostic output.
///
/// Used after applying rename edits to confirm the structural merge is
/// semantically valid.  The check is run with `--message-format=json` so
/// that error and warning counts can be extracted programmatically.
///
/// # Errors
///
/// - [`AnalyzerError::SpawnFailed`] if `cargo` is not on `PATH`.
/// - [`AnalyzerError::InvalidWorkspace`] if `workspace_root` is not a Cargo
///   workspace.
pub fn cargo_check(workspace_root: &PathBuf) -> Result<CheckResult, AnalyzerError> {
    // Stub: production implementation will spawn `cargo check
    // --message-format=json`, read stdout line-by-line, and count
    // `compiler-message` entries whose `message.level == "error"`.
    let _ = workspace_root;
    Err(AnalyzerError::SpawnFailed(
        "stub — production cargo check implementation pending (issue #369)".into(),
    ))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Verify that the stub surfaces the expected error variant so callers
    /// can match on it without touching real system binaries.
    #[test]
    fn init_returns_spawn_failed_stub() {
        let result = RustAnalyzer::init(PathBuf::from("/tmp/fake-workspace"), 5_000);
        assert!(
            matches!(result, Err(AnalyzerError::SpawnFailed(_))),
            "expected SpawnFailed stub, got {:?}",
            result
        );
    }

    /// Verify that `cargo_check` stub returns the expected error variant.
    #[test]
    fn cargo_check_returns_spawn_failed_stub() {
        let result = cargo_check(&PathBuf::from("/tmp/fake-workspace"));
        assert!(
            matches!(result, Err(AnalyzerError::SpawnFailed(_))),
            "expected SpawnFailed stub, got {:?}",
            result
        );
    }

    /// Verify that `CheckResult::is_clean` correctly reflects zero errors.
    #[test]
    fn check_result_is_clean_when_no_errors() {
        let clean = CheckResult {
            error_count: 0,
            warning_count: 3,
            raw_messages: vec![],
        };
        assert!(clean.is_clean());
    }

    /// Verify that `CheckResult::is_clean` returns false when errors exist.
    #[test]
    fn check_result_is_not_clean_when_errors_present() {
        let failing = CheckResult {
            error_count: 2,
            warning_count: 0,
            raw_messages: vec!["E0308".into()],
        };
        assert!(!failing.is_clean());
    }
}
