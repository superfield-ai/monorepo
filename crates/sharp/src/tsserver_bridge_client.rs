//! `TsserverBridgeClient` — Rust subprocess harness that spawns the
//! `tsserver-bridge` TypeScript script and communicates with it over
//! JSON-RPC 2.0 on stdio.
//!
//! # Protocol
//!
//! The bridge reads newline-delimited JSON-RPC 2.0 requests on **stdin** and
//! writes newline-delimited JSON-RPC 2.0 responses on **stdout**.  Both the
//! host (this Rust code) and the bridge speak the same wire format:
//!
//! ```text
//! Request  (host → bridge, one line):
//!   {"jsonrpc":"2.0","id":<n>,"method":"<method>","params":{...}}\n
//!
//! Response (bridge → host, one line):
//!   {"jsonrpc":"2.0","id":<n>,"result":{...}}\n          // success
//!   {"jsonrpc":"2.0","id":<n>,"error":{"code":<n>,"message":"..."}}\n  // error
//! ```
//!
//! # Methods
//!
//! ## `analyze`
//!
//! Detect renamed top-level exported symbols between two TypeScript source strings.
//!
//! Params: `{ "base_content": "<src>", "new_content": "<src>" }`
//!
//! Result: `{ "renames": [{ "old_name": "Foo", "new_name": "Bar", "kind": "function" }, ...] }`
//!
//! ## `apply`
//!
//! Apply a list of renames to a TypeScript source string using the TypeScript
//! LanguageService (`findRenameLocations`).  String literals and comments are
//! preserved; only identifier nodes are rewritten.
//!
//! Params:
//! ```json
//! {
//!   "content":  "<src to rewrite>",
//!   "renames":  [{ "old_name": "Foo", "new_name": "Bar" }, ...]
//! }
//! ```
//!
//! Result: `{ "content": "<rewritten src>", "changed": true }`
//!
//! ## `shutdown`
//!
//! Gracefully stop the bridge.  The bridge sends a success response and exits.
//!
//! # Usage
//!
//! ```no_run
//! use sharp::tsserver_bridge_client::{TsserverBridgeClient, TsserverBridgeClientOptions};
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let mut client = TsserverBridgeClient::new(TsserverBridgeClientOptions::default())?;
//! client.start().await?;
//!
//! let renames = client.analyze(
//!     "export function greet() {}",
//!     "export function hello() {}",
//! ).await?;
//!
//! let result = client.apply(
//!     "import { greet } from './mod'; greet();",
//!     &renames,
//! ).await?;
//!
//! client.stop().await?;
//! # Ok(())
//! # }
//! ```
//!
//! §architecture.md — Sharp subsystem (tsserver-bridge IPC protocol)

use crate::error::SharpError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::time::{timeout, Duration};

// ── Protocol types ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    params: Value,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    result: Option<Value>,
    error: Option<JsonRpcErrorObject>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcErrorObject {
    code: i64,
    message: String,
}

// ── Domain types (public API) ────────────────────────────────────────────────

/// A renamed symbol detected by the TypeScript LanguageService.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TsRename {
    /// The original identifier name (in the base version).
    pub old_name: String,
    /// The new identifier name (in the changed version).
    pub new_name: String,
    /// The kind of the renamed declaration (e.g., `"function"`, `"class"`).
    pub kind: String,
}

/// The result of [`TsserverBridgeClient::apply`].
#[derive(Debug, Clone)]
pub struct ApplyResult {
    /// The rewritten source text.
    pub content: String,
    /// `true` if at least one identifier was actually replaced.
    pub changed: bool,
}

// ── Options ──────────────────────────────────────────────────────────────────

/// Options for constructing a [`TsserverBridgeClient`].
#[derive(Debug, Clone)]
pub struct TsserverBridgeClientOptions {
    /// Path to the Node.js / Bun runtime used to execute the bridge script.
    ///
    /// Defaults to `bun` if available on `PATH`, otherwise `node`.
    pub runtime: Option<PathBuf>,

    /// Path to the `tsserver-bridge.ts` (or compiled `.js`) script.
    ///
    /// Defaults to searching for the script relative to this crate's
    /// `CARGO_MANIFEST_DIR` (i.e., `../../packages/sharp/tsserver-bridge.ts`),
    /// then falling back to `tsserver-bridge` on `PATH`.
    pub bridge_script: Option<PathBuf>,

    /// Maximum milliseconds to wait for a single bridge response.
    /// Defaults to 30 000 ms.
    pub timeout_ms: u64,
}

impl Default for TsserverBridgeClientOptions {
    fn default() -> Self {
        Self {
            runtime: None,
            bridge_script: None,
            timeout_ms: 30_000,
        }
    }
}

// ── Client ───────────────────────────────────────────────────────────────────

/// Manages the lifecycle of a single `tsserver-bridge` subprocess and exposes
/// high-level methods for TypeScript semantic analysis.
pub struct TsserverBridgeClient {
    options: TsserverBridgeClientOptions,
    runtime: PathBuf,
    bridge_script: PathBuf,
    proc: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Option<BufReader<ChildStdout>>,
    next_id: u64,
    started: bool,
}

impl TsserverBridgeClient {
    /// Construct a new client (does **not** start the subprocess yet).
    pub fn new(options: TsserverBridgeClientOptions) -> Result<Self, SharpError> {
        let runtime = if let Some(ref p) = options.runtime {
            p.clone()
        } else {
            Self::find_runtime()?
        };

        let bridge_script = if let Some(ref p) = options.bridge_script {
            p.clone()
        } else {
            Self::find_bridge_script()?
        };

        Ok(Self {
            options,
            runtime,
            bridge_script,
            proc: None,
            stdin: None,
            stdout: None,
            next_id: 1,
            started: false,
        })
    }

    /// Spawn the bridge subprocess.
    pub async fn start(&mut self) -> Result<(), SharpError> {
        if self.started {
            return Ok(());
        }

        let mut child = tokio::process::Command::new(&self.runtime)
            .arg(&self.bridge_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()) // let bridge log to our stderr
            .spawn()
            .map_err(|e| {
                SharpError::TsserverBridgeProcess(format!(
                    "failed to spawn tsserver-bridge ({} {}): {e}",
                    self.runtime.display(),
                    self.bridge_script.display()
                ))
            })?;

        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout piped"));

        self.stdin = Some(stdin);
        self.stdout = Some(stdout);
        self.proc = Some(child);
        self.started = true;
        Ok(())
    }

    /// Send a `shutdown` request and wait for the bridge to exit.
    pub async fn stop(&mut self) -> Result<(), SharpError> {
        if !self.started {
            return Ok(());
        }
        let id = self.next_id();
        let _ = self.send_request(id, "shutdown", json!({})).await;
        // Read the shutdown response (best-effort).
        let _ = self.read_response_for_id(id).await;

        if let Some(mut proc) = self.proc.take() {
            let _ = proc.kill().await;
        }
        self.started = false;
        Ok(())
    }

    /// Detect renamed top-level exported symbols between `base_content` and
    /// `new_content` (both are TypeScript source strings for the same file).
    ///
    /// Returns a list of [`TsRename`] values — may be empty when no unambiguous
    /// rename is detected.
    pub async fn analyze(
        &mut self,
        base_content: &str,
        new_content: &str,
    ) -> Result<Vec<TsRename>, SharpError> {
        let id = self.next_id();
        self.send_request(
            id,
            "analyze",
            json!({
                "base_content": base_content,
                "new_content":  new_content
            }),
        )
        .await?;

        let result = self.read_response_for_id(id).await?;

        #[derive(Deserialize)]
        struct AnalyzeResult {
            renames: Vec<TsRename>,
        }

        let parsed: AnalyzeResult =
            serde_json::from_value(result).map_err(|e| SharpError::Protocol(e.to_string()))?;
        Ok(parsed.renames)
    }

    /// Apply `renames` to `content` using the TypeScript LanguageService.
    ///
    /// Returns the rewritten source and a flag indicating whether anything
    /// actually changed.
    pub async fn apply(
        &mut self,
        content: &str,
        renames: &[TsRename],
    ) -> Result<ApplyResult, SharpError> {
        let rename_params: Vec<Value> = renames
            .iter()
            .map(|r| json!({ "old_name": r.old_name, "new_name": r.new_name }))
            .collect();

        let id = self.next_id();
        self.send_request(
            id,
            "apply",
            json!({
                "content": content,
                "renames": rename_params
            }),
        )
        .await?;

        let result = self.read_response_for_id(id).await?;

        #[derive(Deserialize)]
        struct ApplyResultRaw {
            content: String,
            changed: bool,
        }

        let raw: ApplyResultRaw =
            serde_json::from_value(result).map_err(|e| SharpError::Protocol(e.to_string()))?;
        Ok(ApplyResult {
            content: raw.content,
            changed: raw.changed,
        })
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    async fn send_request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<(), SharpError> {
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.into(),
            params,
        };
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');

        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| SharpError::TsserverBridgeProcess("client not started".into()))?;

        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| SharpError::TsserverBridgeProcess(format!("write error: {e}")))?;
        Ok(())
    }

    async fn read_response_for_id(&mut self, id: u64) -> Result<Value, SharpError> {
        let timeout_duration = Duration::from_millis(self.options.timeout_ms);
        let method_for_error = format!("id={id}");

        timeout(timeout_duration, async {
            loop {
                let line = self.read_line().await?;
                let resp: JsonRpcResponse = serde_json::from_str(&line)
                    .map_err(|e| SharpError::Protocol(format!("malformed response: {e}")))?;

                match &resp.id {
                    Some(Value::Number(n)) if n.as_u64() == Some(id) => {
                        if let Some(err) = resp.error {
                            return Err(SharpError::Protocol(format!(
                                "tsserver-bridge error {}: {}",
                                err.code, err.message
                            )));
                        }
                        return Ok(resp.result.unwrap_or(Value::Null));
                    }
                    _ => continue, // response for a different id or notification
                }
            }
        })
        .await
        .map_err(|_| SharpError::Timeout {
            method: method_for_error,
            timeout_ms: self.options.timeout_ms,
        })?
    }

    async fn read_line(&mut self) -> Result<String, SharpError> {
        let stdout = self
            .stdout
            .as_mut()
            .ok_or_else(|| SharpError::TsserverBridgeProcess("client not started".into()))?;

        let mut line = String::new();
        let n = stdout
            .read_line(&mut line)
            .await
            .map_err(|e| SharpError::TsserverBridgeProcess(format!("stdout read error: {e}")))?;

        if n == 0 {
            return Err(SharpError::TsserverBridgeProcess(
                "tsserver-bridge stdout closed unexpectedly (EOF)".into(),
            ));
        }

        Ok(line)
    }

    /// Locate a suitable JS/TS runtime (bun preferred, node fallback).
    fn find_runtime() -> Result<PathBuf, SharpError> {
        for name in &["bun", "node"] {
            if let Ok(p) = which_simple(name) {
                return Ok(p);
            }
        }
        Err(SharpError::TsserverBridgeProcess(
            "no JS runtime found; install bun or node and add it to PATH".into(),
        ))
    }

    /// Locate the `tsserver-bridge.ts` script.
    ///
    /// Search order:
    /// 1. `<CARGO_MANIFEST_DIR>/../../packages/sharp/tsserver-bridge.ts`
    ///    (works from the crate source tree in development)
    /// 2. A `tsserver-bridge` binary on `PATH`
    fn find_bridge_script() -> Result<PathBuf, SharpError> {
        // In development: the crate lives at `crates/sharp`; the script lives at
        // `packages/sharp/tsserver-bridge.ts`, two directories up.
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let candidate = manifest_dir
            .join("../..")
            .join("packages/sharp/tsserver-bridge.ts");

        if let Ok(canonical) = candidate.canonicalize() {
            if canonical.exists() {
                return Ok(canonical);
            }
        }

        // PATH lookup for a compiled/installed bridge.
        if let Ok(p) = which_simple("tsserver-bridge") {
            return Ok(p);
        }

        Err(SharpError::TsserverBridgeProcess(
            "tsserver-bridge script not found; expected at packages/sharp/tsserver-bridge.ts \
             relative to the repo root, or `tsserver-bridge` on PATH"
                .into(),
        ))
    }
}

// ── Utilities ────────────────────────────────────────────────────────────────

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
