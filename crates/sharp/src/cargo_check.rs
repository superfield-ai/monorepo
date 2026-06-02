//! `CargoCheck` — structural verification gate for Rust semantic merge.
//!
//! Runs `cargo check` inside a given workspace and surfaces any compiler
//! diagnostics.  A merge result that fails `cargo check` is rejected by the
//! semantic merge pipeline before it can be committed.
//!
//! # Design
//!
//! `cargo check --message-format=json` emits one JSON object per line on
//! stdout.  Each line is a `compiler-message` (diagnostic), `build-script-executed`,
//! `compiler-artifact`, or `build-finished` record.  We collect all
//! `compiler-message` entries whose level is `"error"` and surface them as a
//! structured [`CheckResult`].
//!
//! §architecture.md — Sharp subsystem (cargo check verification gate)

use crate::error::SharpError;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;

// ── Output types ─────────────────────────────────────────────────────────────

/// The outcome of a `cargo check` run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckResult {
    /// Whether the workspace compiled without errors.
    pub success: bool,
    /// All compiler error diagnostics (empty if `success` is `true`).
    pub errors: Vec<CompilerError>,
}

/// A single compiler error extracted from `cargo check --message-format=json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompilerError {
    /// The diagnostic message text.
    pub message: String,
    /// The file where the error originates, if known.
    pub file: Option<String>,
    /// The 1-based line number, if known.
    pub line: Option<u32>,
    /// The error code (e.g. `E0308`), if present.
    pub code: Option<String>,
}

// ── Internal JSON shapes (cargo --message-format=json) ─────────────────────

#[derive(Deserialize)]
struct CargoMessage {
    reason: String,
    message: Option<CompilerMessagePayload>,
}

#[derive(Deserialize)]
struct CompilerMessagePayload {
    level: String,
    message: String,
    code: Option<DiagnosticCode>,
    spans: Vec<DiagnosticSpan>,
}

#[derive(Deserialize)]
struct DiagnosticCode {
    code: String,
}

#[derive(Deserialize)]
struct DiagnosticSpan {
    file_name: String,
    line_start: u32,
    is_primary: bool,
}

// ── Entry point ──────────────────────────────────────────────────────────────

/// Run `cargo check` inside `workspace_root` and return the result.
///
/// This function is synchronous from the caller's perspective but spawns
/// `cargo` as a subprocess.  It is `async` because it awaits the child
/// process.
pub async fn run_cargo_check(workspace_root: &Path) -> Result<CheckResult, SharpError> {
    let output = tokio::process::Command::new("cargo")
        .args(["check", "--message-format=json", "--quiet"])
        .current_dir(workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| SharpError::CargoCheckProcess(format!("failed to spawn cargo check: {e}")))?;

    let mut errors: Vec<CompilerError> = Vec::new();

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: CargoMessage = match serde_json::from_str(line) {
            Ok(m) => m,
            Err(_) => continue, // skip unparseable lines
        };
        if msg.reason != "compiler-message" {
            continue;
        }
        let Some(payload) = msg.message else {
            continue;
        };
        if payload.level != "error" {
            continue;
        }
        // Find primary span for file/line info.
        let primary = payload.spans.iter().find(|s| s.is_primary);
        errors.push(CompilerError {
            message: payload.message,
            file: primary.map(|s| s.file_name.clone()),
            line: primary.map(|s| s.line_start),
            code: payload.code.map(|c| c.code),
        });
    }

    // Also treat a non-zero exit and no structured errors as a generic failure
    // (e.g. cargo itself couldn't parse the manifest).
    if !output.status.success() && errors.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(SharpError::CargoCheckFailed(stderr));
    }

    Ok(CheckResult {
        success: errors.is_empty(),
        errors,
    })
}

impl CheckResult {
    /// Format the errors into a human-readable string for error messages.
    pub fn format_errors(&self) -> String {
        self.errors
            .iter()
            .map(|e| {
                let location = match (&e.file, &e.line) {
                    (Some(f), Some(l)) => format!("{f}:{l}: "),
                    (Some(f), None) => format!("{f}: "),
                    _ => String::new(),
                };
                let code = e
                    .code
                    .as_deref()
                    .map(|c| format!("[{c}] "))
                    .unwrap_or_default();
                format!("{location}{code}{}", e.message)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}
