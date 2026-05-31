//! `RustAnalyzerClient` — orchestrates the `rust-analyzer` language server as
//! a subprocess to enumerate rename locations in Rust source files.
//!
//! # Protocol
//!
//! rust-analyzer implements the Language Server Protocol (LSP) over
//! stdin/stdout using JSON-RPC 2.0.  Messages are framed with HTTP-style
//! headers:
//!
//! ```text
//! Content-Length: <byte-length>\r\n
//! \r\n
//! <JSON body>\r\n
//! ```
//!
//! The client sends `initialize` → waits for `initialized` → sends
//! `textDocument/didOpen` to register each file → sends
//! `textDocument/rename` (preparatory) and `textDocument/references` (for
//! rename enumeration) → sends `shutdown` + `exit` when done.
//!
//! # Usage
//!
//! ```no_run
//! use sharp::rust_analyzer_client::{RustAnalyzerClient, RustAnalyzerClientOptions};
//! use std::path::Path;
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let mut client = RustAnalyzerClient::new(RustAnalyzerClientOptions {
//!     workspace_root: "/path/to/rust/project".into(),
//!     ..Default::default()
//! })?;
//! client.start().await?;
//!
//! let file = Path::new("/path/to/rust/project/src/lib.rs");
//! let locations = client.get_rename_locations(
//!     file,
//!     2,   // 0-based line
//!     4,   // 0-based UTF-16 character offset
//!     true, // include declaration
//! ).await?;
//!
//! client.stop().await?;
//! # Ok(())
//! # }
//! ```
//!
//! §architecture.md — Sharp subsystem (language-server-backed analysis)

use crate::error::SharpError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::time::{Duration, timeout};

// ── LSP types ──────────────────────────────────────────────────────────────

/// A position in a text document (0-based line and character).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LspPosition {
    /// 0-based line number.
    pub line: u32,
    /// 0-based UTF-16 character offset.
    pub character: u32,
}

/// A range in a text document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

/// A location in a text document (file URI + range).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LspLocation {
    pub uri: String,
    pub range: LspRange,
}

/// A rename location returned by the LSP `textDocument/references` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameLocation {
    /// Absolute path of the file containing the symbol occurrence.
    pub file: PathBuf,
    /// 0-based start line.
    pub start_line: u32,
    /// 0-based start character.
    pub start_character: u32,
    /// 0-based end line.
    pub end_line: u32,
    /// 0-based end character.
    pub end_character: u32,
}

// ── JSON-RPC helpers ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcResponse {
    jsonrpc: Option<String>,
    id: Option<Value>,
    result: Option<Value>,
    error: Option<Value>,
    method: Option<String>,
    params: Option<Value>,
}

// ── Options ─────────────────────────────────────────────────────────────────

/// Options for constructing a [`RustAnalyzerClient`].
#[derive(Debug, Clone)]
pub struct RustAnalyzerClientOptions {
    /// Absolute path to the `rust-analyzer` binary.
    /// Defaults to the first `rust-analyzer` found via `PATH` or, if not
    /// found, the rustup component path.
    pub rust_analyzer_path: Option<PathBuf>,
    /// Absolute path to the Cargo workspace root (the directory containing
    /// the top-level `Cargo.toml`).  This is passed as the LSP
    /// `rootUri` / `workspaceFolders`.
    pub workspace_root: PathBuf,
    /// Maximum milliseconds to wait for a single LSP response.
    /// Defaults to 60 000 ms (60 s) — rust-analyzer can be slow on first
    /// open because it indexes the crate.
    pub timeout_ms: u64,
}

impl Default for RustAnalyzerClientOptions {
    fn default() -> Self {
        Self {
            rust_analyzer_path: None,
            workspace_root: std::env::current_dir().unwrap_or_default(),
            timeout_ms: 60_000,
        }
    }
}

// ── Client ──────────────────────────────────────────────────────────────────

/// Manages the lifecycle of a single `rust-analyzer` subprocess and exposes
/// high-level methods for rename-location enumeration.
pub struct RustAnalyzerClient {
    options: RustAnalyzerClientOptions,
    ra_path: PathBuf,
    proc: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Option<BufReader<ChildStdout>>,
    next_id: u64,
    initialized: bool,
}

impl RustAnalyzerClient {
    /// Construct a new client (does not start the subprocess yet).
    pub fn new(options: RustAnalyzerClientOptions) -> Result<Self, SharpError> {
        let ra_path = if let Some(ref p) = options.rust_analyzer_path {
            p.clone()
        } else {
            Self::find_rust_analyzer()?
        };
        Ok(Self {
            options,
            ra_path,
            proc: None,
            stdin: None,
            stdout: None,
            next_id: 1,
            initialized: false,
        })
    }

    /// Locate the `rust-analyzer` binary.
    ///
    /// Search order:
    /// 1. `PATH`
    /// 2. `$(rustup which rust-analyzer)` (silently ignores errors)
    fn find_rust_analyzer() -> Result<PathBuf, SharpError> {
        // 1. PATH
        if let Ok(p) = which_simple("rust-analyzer") {
            return Ok(p);
        }
        // 2. rustup
        if let Ok(output) = std::process::Command::new("rustup")
            .args(["which", "rust-analyzer"])
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(PathBuf::from(path));
                }
            }
        }
        Err(SharpError::RustAnalyzerProcess(
            "rust-analyzer binary not found on PATH or via rustup; \
             install it with `rustup component add rust-analyzer`"
                .into(),
        ))
    }

    /// Spawn `rust-analyzer`, perform the LSP handshake, and leave the client
    /// ready to serve requests.
    pub async fn start(&mut self) -> Result<(), SharpError> {
        if self.initialized {
            return Ok(());
        }

        let mut child = tokio::process::Command::new(&self.ra_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                SharpError::RustAnalyzerProcess(format!("failed to spawn rust-analyzer: {e}"))
            })?;

        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout piped"));

        self.stdin = Some(stdin);
        self.stdout = Some(stdout);
        self.proc = Some(child);

        // Initialize handshake.
        let root_uri = path_to_uri(&self.options.workspace_root);
        let id = self.next_id();
        self.send_request(
            id,
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": root_uri,
                "workspaceFolders": [
                    { "uri": root_uri, "name": "workspace" }
                ],
                "capabilities": {
                    "textDocument": {
                        "references": { "dynamicRegistration": false },
                        "rename": { "dynamicRegistration": false }
                    },
                    "workspace": {
                        "workspaceFolders": true
                    }
                },
                "initializationOptions": {}
            }),
        )
        .await?;

        // Wait for the initialize result (ignore its content for now).
        self.read_response_for_id(id).await?;

        // Send initialized notification (no response expected).
        self.send_notification("initialized", json!({})).await?;

        self.initialized = true;
        Ok(())
    }

    /// Gracefully shut down the `rust-analyzer` subprocess.
    pub async fn stop(&mut self) -> Result<(), SharpError> {
        if !self.initialized {
            return Ok(());
        }
        let id = self.next_id();
        let _ = self.send_request(id, "shutdown", json!(null)).await;
        let _ = self.read_response_for_id(id).await;
        let _ = self.send_notification("exit", json!(null)).await;
        if let Some(mut proc) = self.proc.take() {
            let _ = proc.kill().await;
        }
        self.initialized = false;
        Ok(())
    }

    /// Notify rust-analyzer that a file is open with the given content.
    pub async fn open_file(&mut self, path: &Path, content: &str) -> Result<(), SharpError> {
        let uri = path_to_uri(path);
        self.send_notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": "rust",
                    "version": 1,
                    "text": content
                }
            }),
        )
        .await
    }

    /// Notify rust-analyzer that a file has changed in-memory.
    pub async fn change_file(&mut self, path: &Path, content: &str) -> Result<(), SharpError> {
        let uri = path_to_uri(path);
        self.send_notification(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": uri, "version": 2 },
                "contentChanges": [{ "text": content }]
            }),
        )
        .await
    }

    /// Close a previously opened file.
    pub async fn close_file(&mut self, path: &Path) -> Result<(), SharpError> {
        let uri = path_to_uri(path);
        self.send_notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": uri } }),
        )
        .await
    }

    /// Return all reference locations for the symbol at `(line, character)`
    /// (0-based).  This is the mechanism used for rename enumeration: every
    /// location that refers to the symbol must be updated when it is renamed.
    ///
    /// The declaration itself is included in the result when
    /// `include_declaration` is `true`.
    pub async fn get_rename_locations(
        &mut self,
        file: &Path,
        line: u32,
        character: u32,
        include_declaration: bool,
    ) -> Result<Vec<RenameLocation>, SharpError> {
        let id = self.next_id();
        let uri = path_to_uri(file);

        self.send_request(
            id,
            "textDocument/references",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": line, "character": character },
                "context": { "includeDeclaration": include_declaration }
            }),
        )
        .await?;

        let result = self.read_response_for_id(id).await?;

        // The result is an array of Location objects or null.
        let locations = match result {
            Value::Null => vec![],
            Value::Array(arr) => arr
                .into_iter()
                .filter_map(|v| {
                    let loc: LspLocation = serde_json::from_value(v).ok()?;
                    let file_path = uri_to_path(&loc.uri);
                    Some(RenameLocation {
                        file: file_path,
                        start_line: loc.range.start.line,
                        start_character: loc.range.start.character,
                        end_line: loc.range.end.line,
                        end_character: loc.range.end.character,
                    })
                })
                .collect(),
            other => {
                return Err(SharpError::Protocol(format!(
                    "unexpected result for textDocument/references: {other}"
                )));
            }
        };

        Ok(locations)
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    async fn send_request(&mut self, id: u64, method: &str, params: Value) -> Result<(), SharpError> {
        let msg = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        };
        let body = serde_json::to_string(&msg)?;
        let framed = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| SharpError::RustAnalyzerProcess("client not started".into()))?;
        stdin
            .write_all(framed.as_bytes())
            .await
            .map_err(|e| SharpError::RustAnalyzerProcess(format!("write error: {e}")))?;
        Ok(())
    }

    async fn send_notification(&mut self, method: &str, params: Value) -> Result<(), SharpError> {
        #[derive(Serialize)]
        struct Notification {
            jsonrpc: &'static str,
            method: String,
            params: Value,
        }
        let msg = Notification {
            jsonrpc: "2.0",
            method: method.into(),
            params,
        };
        let body = serde_json::to_string(&msg)?;
        let framed = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| SharpError::RustAnalyzerProcess("client not started".into()))?;
        stdin
            .write_all(framed.as_bytes())
            .await
            .map_err(|e| SharpError::RustAnalyzerProcess(format!("write error: {e}")))?;
        Ok(())
    }

    /// Read messages until we find a response with the given `id`.
    /// Notifications and server-initiated requests are discarded.
    async fn read_response_for_id(&mut self, id: u64) -> Result<Value, SharpError> {
        let timeout_duration = Duration::from_millis(self.options.timeout_ms);
        let method_for_error = format!("id={id}");

        timeout(timeout_duration, async {
            loop {
                let msg = self.read_message().await?;
                // Distinguish notification vs response.
                // A response has `id`; a notification has `method` but no `id`.
                let response: JsonRpcResponse = serde_json::from_value(msg)?;
                match &response.id {
                    Some(Value::Number(n)) if n.as_u64() == Some(id) => {
                        if let Some(err) = response.error {
                            return Err(SharpError::Protocol(format!(
                                "LSP error for id={id}: {err}"
                            )));
                        }
                        return Ok(response.result.unwrap_or(Value::Null));
                    }
                    _ => {
                        // Notification or response for a different id — skip.
                        continue;
                    }
                }
            }
        })
        .await
        .map_err(|_| SharpError::Timeout {
            method: method_for_error,
            timeout_ms: self.options.timeout_ms,
        })?
    }

    /// Read one LSP message from stdout (Content-Length framed).
    async fn read_message(&mut self) -> Result<Value, SharpError> {
        let stdout = self
            .stdout
            .as_mut()
            .ok_or_else(|| SharpError::RustAnalyzerProcess("client not started".into()))?;

        // Read headers until blank line.
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            stdout
                .read_line(&mut line)
                .await
                .map_err(|e| SharpError::RustAnalyzerProcess(format!("stdout read error: {e}")))?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                break; // blank line separates headers from body
            }
            if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                content_length = rest.trim().parse().ok();
            }
        }

        let len = content_length.ok_or_else(|| {
            SharpError::Protocol("LSP message missing Content-Length header".into())
        })?;

        let mut body = vec![0u8; len];
        stdout
            .read_exact(&mut body)
            .await
            .map_err(|e| SharpError::RustAnalyzerProcess(format!("stdout read body error: {e}")))?;

        let value: Value = serde_json::from_slice(&body)?;
        Ok(value)
    }
}

// ── Utilities ───────────────────────────────────────────────────────────────

/// Convert an absolute path to a `file://` URI.
fn path_to_uri(path: &Path) -> String {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(path)
    };
    format!("file://{}", abs.display())
}

/// Convert a `file://` URI back to an absolute path.
fn uri_to_path(uri: &str) -> PathBuf {
    PathBuf::from(uri.strip_prefix("file://").unwrap_or(uri))
}

/// Simple `which`-equivalent: search PATH for the binary.
fn which_simple(name: &str) -> Result<PathBuf, ()> {
    let path_var = std::env::var("PATH").map_err(|_| ())?;
    for dir in path_var.split(':') {
        let candidate = PathBuf::from(dir).join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}
