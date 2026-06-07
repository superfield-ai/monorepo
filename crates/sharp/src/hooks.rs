//! Pre-merge (and general) hooks — the decoupled-toolchain layer.
//!
//! Ports the TypeScript hooks system (`sharp/apps/client/src/hooks/index.ts`)
//! per whitepaper §6.3 and engineering-plan §7a.
//!
//! Discovers executable files under `.sharp/hooks/<event>/`, runs each with a
//! JSON context on stdin and a chosen `cwd` (for pre-merge, the materialized
//! candidate tree), and treats a non-zero exit (or timeout) as a veto for
//! events that support veto.
//!
//! The merge engine is decoupled from any specific toolchain — it only invokes
//! whatever the user has dropped into `.sharp/hooks/`.
//!
//! §architecture.md — Sharp subsystem (pre-merge hooks)

use crate::error::SharpError;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::time::{timeout, Duration};

/// Lifecycle events that may carry hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    PreCommit,
    PostCommit,
    PreMerge,
    PostMerge,
    PrePush,
}

impl HookEvent {
    /// The on-disk directory segment for this event under `.sharp/hooks/`.
    pub fn dir_name(self) -> &'static str {
        match self {
            HookEvent::PreCommit => "pre-commit",
            HookEvent::PostCommit => "post-commit",
            HookEvent::PreMerge => "pre-merge",
            HookEvent::PostMerge => "post-merge",
            HookEvent::PrePush => "pre-push",
        }
    }
}

/// The result of executing a single hook.
#[derive(Debug, Clone)]
pub struct HookResult {
    /// Absolute path of the hook executable.
    pub hook_path: PathBuf,
    /// Process exit code (`-1` on spawn error; `137` for SIGKILL on timeout).
    pub exit_code: i32,
    /// Captured stdout.
    pub stdout: String,
    /// Captured stderr.
    pub stderr: String,
    /// Whether the hook was killed for exceeding [`HookExecOptions::timeout_ms`].
    pub timed_out: bool,
    /// Wall-clock duration in milliseconds.
    pub duration_ms: u128,
}

impl HookResult {
    /// A hook "passed" iff it exited 0 and did not time out.
    pub fn ok(&self) -> bool {
        self.exit_code == 0 && !self.timed_out
    }
}

/// Options controlling hook execution.
#[derive(Debug, Clone)]
pub struct HookExecOptions {
    /// Working directory the hook runs in. For pre-merge, the candidate tree.
    pub cwd: PathBuf,
    /// JSON-serializable context written to the hook's stdin (already encoded).
    pub context: Option<String>,
    /// Wall-clock timeout per hook in milliseconds. Defaults to 60 000.
    pub timeout_ms: u64,
}

impl Default for HookExecOptions {
    fn default() -> Self {
        Self {
            cwd: PathBuf::from("."),
            context: None,
            timeout_ms: 60_000,
        }
    }
}

/// Discover executable hooks for `event` under `<workspace_root>/.sharp/hooks/`.
///
/// Returns absolute paths sorted lexicographically (the run order). Honors the
/// POSIX executable bit; non-executable files are skipped. A missing directory
/// yields an empty list, not an error.
pub async fn discover_hooks(
    workspace_root: &Path,
    event: HookEvent,
) -> Result<Vec<PathBuf>, SharpError> {
    let dir = workspace_root
        .join(".sharp")
        .join("hooks")
        .join(event.dir_name());

    let mut out: Vec<PathBuf> = Vec::new();
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(rd) => rd,
        Err(_) => return Ok(out), // missing dir → no hooks
    };

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| SharpError::Io(e))?
    {
        let path = entry.path();
        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            // `read_dir` followed by `metadata` resolves symlinks, so a
            // symlink to a file is reported as a file here.
            continue;
        }
        if is_executable(&meta) {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    // Sharp's target hosts are Linux/macOS; on other platforms treat all
    // regular files as runnable.
    true
}

/// Run a single hook executable. Never returns `Err` for a hook that merely
/// fails or times out — those are reported via the [`HookResult`] fields. An
/// `Err` is only returned for unexpected host I/O issues.
pub async fn run_hook(hook_path: &Path, opts: &HookExecOptions) -> Result<HookResult, SharpError> {
    let start = Instant::now();

    let spawn = tokio::process::Command::new(hook_path)
        .current_dir(&opts.cwd)
        .env("SHARP_HOOK", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn {
        Ok(c) => c,
        Err(e) => {
            return Ok(HookResult {
                hook_path: hook_path.to_path_buf(),
                exit_code: -1,
                stdout: String::new(),
                stderr: format!("\n[hook] spawn error: {e}"),
                timed_out: false,
                duration_ms: start.elapsed().as_millis(),
            });
        }
    };

    // Write the context to stdin and close it.
    if let Some(stdin) = child.stdin.take() {
        let mut stdin = stdin;
        if let Some(ctx) = &opts.context {
            let _ = stdin.write_all(ctx.as_bytes()).await;
        }
        let _ = stdin.shutdown().await;
        drop(stdin);
    }

    let wait = child.wait_with_output();
    let dur = Duration::from_millis(opts.timeout_ms);

    match timeout(dur, wait).await {
        Ok(Ok(output)) => {
            let code = output.status.code().unwrap_or_else(|| {
                // Killed by signal.
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    output.status.signal().map(|s| 128 + s).unwrap_or(-1)
                }
                #[cfg(not(unix))]
                {
                    -1
                }
            });
            Ok(HookResult {
                hook_path: hook_path.to_path_buf(),
                exit_code: code,
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                timed_out: false,
                duration_ms: start.elapsed().as_millis(),
            })
        }
        Ok(Err(e)) => Ok(HookResult {
            hook_path: hook_path.to_path_buf(),
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("\n[hook] wait error: {e}"),
            timed_out: false,
            duration_ms: start.elapsed().as_millis(),
        }),
        Err(_) => {
            // Timed out: the child was dropped (which kills it on tokio).
            Ok(HookResult {
                hook_path: hook_path.to_path_buf(),
                exit_code: 137, // 128 + SIGKILL
                stdout: String::new(),
                stderr: String::new(),
                timed_out: true,
                duration_ms: start.elapsed().as_millis(),
            })
        }
    }
}

/// Outcome of running every hook for an event in lex order.
#[derive(Debug, Clone)]
pub struct HooksRun {
    /// `true` iff every hook passed.
    pub ok: bool,
    /// Results collected so far (stops after the first failure for veto).
    pub results: Vec<HookResult>,
}

/// Run every hook in `hook_paths` in order. Stops at the first failing hook
/// (non-zero exit or timeout) and reports `ok: false`.
pub async fn run_hooks(
    hook_paths: &[PathBuf],
    opts: &HookExecOptions,
) -> Result<HooksRun, SharpError> {
    let mut results = Vec::new();
    for path in hook_paths {
        let r = run_hook(path, opts).await?;
        let passed = r.ok();
        results.push(r);
        if !passed {
            return Ok(HooksRun { ok: false, results });
        }
    }
    Ok(HooksRun { ok: true, results })
}

/// Run the pre-merge hooks for `workspace_root` against a materialized
/// candidate tree at `candidate_root`. Returns `Ok(())` when no hooks veto.
///
/// On veto, returns [`SharpError::HookVeto`] carrying the failing hook path and
/// a reason (exit code or timeout plus any stderr). This is the convenience
/// entry point the merge engine calls before accepting a clean candidate.
pub async fn run_pre_merge_hooks(
    workspace_root: &Path,
    candidate_root: &Path,
    context: Option<String>,
) -> Result<(), SharpError> {
    let hooks = discover_hooks(workspace_root, HookEvent::PreMerge).await?;
    if hooks.is_empty() {
        return Ok(());
    }
    let opts = HookExecOptions {
        cwd: candidate_root.to_path_buf(),
        context,
        timeout_ms: 60_000,
    };
    let run = run_hooks(&hooks, &opts).await?;
    if run.ok {
        return Ok(());
    }
    let failed = run
        .results
        .last()
        .expect("a failed run has at least one result");
    let detail = if failed.timed_out {
        "timed out".to_string()
    } else {
        let mut d = format!("exited {}", failed.exit_code);
        let stderr = failed.stderr.trim();
        if !stderr.is_empty() {
            d.push_str(" — ");
            d.push_str(stderr);
        }
        d
    };
    Err(SharpError::HookVeto {
        hook: failed.hook_path.display().to_string(),
        reason: detail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_dir_names() {
        assert_eq!(HookEvent::PreMerge.dir_name(), "pre-merge");
        assert_eq!(HookEvent::PreCommit.dir_name(), "pre-commit");
    }

    #[tokio::test]
    async fn missing_dir_yields_no_hooks() {
        let tmp = tempfile::tempdir().unwrap();
        let hooks = discover_hooks(tmp.path(), HookEvent::PreMerge)
            .await
            .unwrap();
        assert!(hooks.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovers_only_executables() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".sharp/hooks/pre-merge");
        std::fs::create_dir_all(&dir).unwrap();
        // Executable hook.
        let exec = dir.join("a-check");
        std::fs::write(&exec, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&exec, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Non-executable file.
        let plain = dir.join("b-readme");
        std::fs::write(&plain, "not a hook").unwrap();
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();

        let hooks = discover_hooks(tmp.path(), HookEvent::PreMerge)
            .await
            .unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].file_name().unwrap(), "a-check");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_hook_captures_exit_and_output() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let hook = tmp.path().join("h");
        std::fs::write(&hook, "#!/bin/sh\necho hi\nexit 3\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let opts = HookExecOptions {
            cwd: tmp.path().to_path_buf(),
            ..Default::default()
        };
        let r = run_hook(&hook, &opts).await.unwrap();
        assert_eq!(r.exit_code, 3);
        assert!(!r.ok());
        assert!(r.stdout.contains("hi"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pre_merge_veto_on_nonzero() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".sharp/hooks/pre-merge");
        std::fs::create_dir_all(&dir).unwrap();
        let hook = dir.join("fail");
        std::fs::write(&hook, "#!/bin/sh\necho boom 1>&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

        let candidate = tempfile::tempdir().unwrap();
        let err = run_pre_merge_hooks(tmp.path(), candidate.path(), None)
            .await
            .unwrap_err();
        match err {
            SharpError::HookVeto { reason, .. } => assert!(reason.contains("boom")),
            other => panic!("expected HookVeto, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pre_merge_passes_when_hook_succeeds() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".sharp/hooks/pre-merge");
        std::fs::create_dir_all(&dir).unwrap();
        let hook = dir.join("ok");
        std::fs::write(&hook, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

        let candidate = tempfile::tempdir().unwrap();
        assert!(run_pre_merge_hooks(tmp.path(), candidate.path(), None)
            .await
            .is_ok());
    }
}
