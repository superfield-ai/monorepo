// ci_executor.rs — the manifest EXECUTOR.
//
// Canonical docs:
//   - docs/adr-ci-execution-manifest.md  ("FastENV is the substrate" — it runs
//     the manifest natively, NOT via an ACT-style GitHub-runner emulator)
//   - docs/testing-invariants.md
//
// STATUS (issue #822 — real implementation)
// =====================================================================
// This module runs a `crate::manifest::CiManifest` natively on the FastENV
// substrate. It:
//
//   1. resolves the `needs` DAG into a deterministic execution order
//      (Kahn topo-sort; cycles and dangling edges FAIL LOUDLY);
//   2. for each job, prepares an isolated fork workspace, runs every
//      `Command` in order on the substrate, then ALWAYS discards the fork
//      (no host-disk accumulation — the ACT non-goal);
//   3. enforces the `TestContract` loudly: a non-zero command exit fails the
//      graph (this is how `--no-tests=fail` / a missing `FailLoud` resource
//      propagates, never silently skipped), and a reported executed-test count
//      below `min_executed_tests` (or zero when `zero_tests_is_failure`) bails.
//
// ACT-lessons NON-GOALS honoured by construction (these are acceptance
// criteria): no hosted-runner emulation; no GHA marketplace-action / context /
// `permissions:` surface; no host-runner-disk accumulation (every fork is
// du-measured then discarded); no ghcr auth coupling; no `.actrc`-style
// runner-label remapping; no host `node` dependency; no blocking model
// downloads mid-run. The executor dispatches ONLY the manifest's declared
// `Command`s — it injects nothing of its own beyond the requested env.
//
// SEAMS: the execution logic is split behind two injectable traits
// (`JobSubstrate`, `WorkspaceManager`) so it is testable both with the real,
// hermetic `exec::run_exec` pipeline and with fakes — and so a real
// executed-test-count runner (libtest-json parse) can land later WITHOUT
// changing the `CiExecutor` trait.
//
// DISJOINT SURFACE: issue #822 owns THIS FILE. #823 owns ci_import.rs and #824
// owns ci_gate.rs; none of the three overlap.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{bail, Context, Result};

use crate::exec::{self, ExecOptions, GuestNetworkMode};
use crate::manifest::{CiManifest, Command, Job, SchemaVersion};
use crate::{discard, du, fork, registry::Registry};

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/// The outcome of executing a single job's commands.
///
/// Constructed only by this module; the validation gate (issue #824) consumes
/// `executed_tests` / `passed` as the gate-relevant per-job outputs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobResult {
    /// The job's id.
    pub id: String,
    /// How many of the job's declared commands actually ran.
    pub commands_run: u32,
    /// The exit code of the last command that ran (0 on a fully-passing job).
    pub exit_code: i32,
    /// The number of tests the substrate reported as EXECUTED, if it supplies a
    /// count. `None` means the substrate does not (yet) parse counts — the real
    /// `ExecSubstrate` returns `None` today; fakes and a future libtest-json
    /// runner supply `Some(n)`.
    pub executed_tests: Option<u32>,
    /// Whether the job passed (all commands exited 0 AND the `TestContract`
    /// structural checks held). A job that reaches this struct is always
    /// `passed = true`; a failed job propagates an `Err` instead of a
    /// `passed = false` result, so a failure can NEVER be read as a pass.
    pub passed: bool,
}

/// The outcome of executing a manifest's job graph.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecutionReport {
    /// Ids of jobs that ran, in the order they were executed.
    pub executed_jobs: Vec<String>,
    /// Per-job results, in execution order.
    pub job_results: Vec<JobResult>,
    /// Upper-bound bytes reclaimed by discarding every job's fork workspace
    /// (the no-host-disk-accumulation evidence).
    pub bytes_reclaimed: u64,
}

// ---------------------------------------------------------------------------
// The CiExecutor trait + the no-op stub (#821 seam — kept as-is)
// ---------------------------------------------------------------------------

/// Runs a `CiManifest`'s job graph natively on the FastENV substrate.
pub trait CiExecutor {
    /// Execute the manifest's job graph and report what ran.
    fn execute(&self, manifest: &CiManifest) -> Result<ExecutionReport>;
}

/// Compile-safe no-op executor. Exists only so the seam is referenceable and
/// link-checked (the #821 `seams_are_wired_and_compile_safe` test references it
/// as a trait object). It implements no real execution and panics loudly if
/// ever called so a premature wiring is never a false green.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnimplementedExecutor;

impl CiExecutor for UnimplementedExecutor {
    fn execute(&self, _manifest: &CiManifest) -> Result<ExecutionReport> {
        unimplemented!(
            "UnimplementedExecutor is the link-check stub; use FastenvCiExecutor for real execution"
        )
    }
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/// The outcome of running one command on the substrate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutcome {
    /// The command's process exit code.
    pub exit_code: i32,
    /// The number of tests observed as EXECUTED, if the substrate parses a
    /// count. `None` = not measured (the real exec path today).
    pub executed_tests: Option<u32>,
}

/// Runs a single manifest `Command` inside a prepared fork workspace.
pub trait JobSubstrate {
    /// Run `command` inside `fork_id` (rooted at `root`) and report its outcome.
    fn run_command(&self, fork_id: &str, command: &Command, root: &Path) -> Result<CommandOutcome>;
}

/// Prepares and tears down a per-job fork workspace.
pub trait WorkspaceManager {
    /// Provision an isolated workspace for `job_id`; return its fork id.
    fn prepare(&self, job_id: &str, root: &Path) -> Result<String>;
    /// Discard the workspace, returning an upper bound on bytes reclaimed.
    fn cleanup(&self, fork_id: &str, root: &Path) -> Result<u64>;
}

// ---------------------------------------------------------------------------
// Production substrate: drives exec::run_exec
// ---------------------------------------------------------------------------

/// Production `JobSubstrate` backed by the real `exec::run_exec` container
/// pipeline. The manifest `Command.env` is injected via an `/usr/bin/env
/// K=V ...` argv prefix (sorted, deterministic) so the heavily-tested shared
/// `exec.rs` — which today only injects PATH + secret leases — is not edited.
#[derive(Debug, Clone)]
pub struct ExecSubstrate {
    /// Path to the crun binary handed to `ExecOptions`.
    pub crun_path: String,
    /// Guest network mode for the container.
    pub network: GuestNetworkMode,
}

impl JobSubstrate for ExecSubstrate {
    fn run_command(&self, fork_id: &str, command: &Command, root: &Path) -> Result<CommandOutcome> {
        // Build argv. When the command declares env, prefix `/usr/bin/env K=V`
        // so the values reach the process WITHOUT editing exec.rs. The
        // BTreeMap iteration order is sorted, so argv is deterministic.
        let mut argv: Vec<String> = Vec::new();
        if !command.env.is_empty() {
            argv.push("/usr/bin/env".to_owned());
            for (k, v) in &command.env {
                argv.push(format!("{k}={v}"));
            }
        }
        argv.push(command.program.clone());
        argv.extend(command.args.iter().cloned());

        let opts = ExecOptions {
            crun_path: self.crun_path.clone(),
            network: self.network,
            ..ExecOptions::default()
        };
        let exit_code = exec::run_exec(fork_id, &argv, root, &opts)?;
        // Real executed-test counting (libtest-json parse) is a follow-on; the
        // exec path inherits stdio and returns only an exit code today.
        Ok(CommandOutcome {
            exit_code,
            executed_tests: None,
        })
    }
}

// ---------------------------------------------------------------------------
// Production workspace manager: fork + measure + discard
// ---------------------------------------------------------------------------

/// Monotonic suffix so concurrent / repeated job ids get distinct fork ids.
static FORK_SEQ: AtomicU64 = AtomicU64::new(0);

/// Production `WorkspaceManager`: forks from a configured base for each job,
/// measures the fork's upper layer with `du::walk_upper_bytes`, then discards
/// it via `discard::discard_fork`. Nothing accumulates on the host disk.
#[derive(Debug, Clone)]
pub struct ForkWorkspaceManager {
    /// The base snapshot key every job forks from.
    pub base: String,
}

impl WorkspaceManager for ForkWorkspaceManager {
    fn prepare(&self, job_id: &str, root: &Path) -> Result<String> {
        let seq = FORK_SEQ.fetch_add(1, Ordering::Relaxed);
        let fork_id = format!("ci-{}-{seq}", sanitize_fork_id(job_id));
        fork::fork_base(&self.base, &fork_id, root, None)
            .with_context(|| format!("ci-executor: failed to fork workspace for job '{job_id}'"))?;
        Ok(fork_id)
    }

    fn cleanup(&self, fork_id: &str, root: &Path) -> Result<u64> {
        // Measure the upper layer BEFORE discarding so the reclaimed-bytes
        // figure reflects what this fork actually wrote.
        let reclaimed = Registry::open(root)
            .ok()
            .and_then(|reg| reg.get_fork(fork_id).ok())
            .map(|entry| du::walk_upper_bytes(&entry.upper_path).unwrap_or(0))
            .unwrap_or(0);
        discard::discard_fork(fork_id, root)
            .with_context(|| format!("ci-executor: failed to discard fork '{fork_id}'"))?;
        Ok(reclaimed)
    }
}

/// Reduce a job id to characters safe for a fork directory name.
fn sanitize_fork_id(job_id: &str) -> String {
    job_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/// Executes a `CiManifest` job graph on the FastENV substrate.
pub struct FastenvCiExecutor<S: JobSubstrate, W: WorkspaceManager> {
    /// fastenv data root (e.g. `/var/lib/fastenv`).
    pub root: PathBuf,
    /// How commands are run.
    pub substrate: S,
    /// How per-job workspaces are provisioned and torn down.
    pub workspace: W,
}

impl<S: JobSubstrate, W: WorkspaceManager> FastenvCiExecutor<S, W> {
    /// Run a single job's commands in order, enforcing its `TestContract`.
    /// Returns `Ok(JobResult{passed:true})` only if every command exited 0 and
    /// the structural test checks held; otherwise returns a loud `Err`.
    fn run_job(&self, job: &Job, fork_id: &str) -> Result<JobResult> {
        let mut commands_run = 0u32;
        let mut last_exit = 0i32;
        let mut executed_tests: Option<u32> = None;

        for command in &job.commands {
            let outcome = self
                .substrate
                .run_command(fork_id, command, &self.root)
                .with_context(|| {
                    format!(
                        "ci-executor: job '{}' command '{}' failed to dispatch",
                        job.id, command.program
                    )
                })?;
            commands_run += 1;
            last_exit = outcome.exit_code;
            if let Some(n) = outcome.executed_tests {
                executed_tests = Some(executed_tests.unwrap_or(0) + n);
            }

            // Loud failure: a non-zero exit fails the whole graph. This is how a
            // `--no-tests=fail` (zero collected tests) result and a missing
            // `on_missing_resource: FailLoud` resource propagate — never
            // swallowed, never treated as a pass, never skipped.
            if outcome.exit_code != 0 {
                bail!(
                    "ci-executor: job '{}' command '{}' {:?} exited with code {} — \
                     failing the graph loudly (a failed/missing-resource job is never \
                     skipped or counted as a pass)",
                    job.id,
                    command.program,
                    command.args,
                    outcome.exit_code
                );
            }
        }

        // Structural TestContract enforcement against any reported count.
        let contract = &job.test_contract;
        if let Some(n) = executed_tests {
            if n < contract.min_executed_tests {
                bail!(
                    "ci-executor: job '{}' executed {} tests but min_executed_tests is {} — \
                     failing loudly (exit 0 != tested)",
                    job.id,
                    n,
                    contract.min_executed_tests
                );
            }
            if n == 0 && contract.zero_tests_is_failure {
                bail!(
                    "ci-executor: job '{}' collected zero tests and zero_tests_is_failure is set — \
                     failing loudly (never a silent green)",
                    job.id
                );
            }
        }

        Ok(JobResult {
            id: job.id.clone(),
            commands_run,
            exit_code: last_exit,
            executed_tests,
            passed: true,
        })
    }
}

impl<S: JobSubstrate, W: WorkspaceManager> CiExecutor for FastenvCiExecutor<S, W> {
    fn execute(&self, manifest: &CiManifest) -> Result<ExecutionReport> {
        // Reject any schema version the executor was not taught. serde already
        // rejects unknown version strings at parse time; this match is the
        // in-code guard that fails to COMPILE when a new variant is added but
        // the executor has not handled it yet (loud, never silent).
        match manifest.manifest_version {
            SchemaVersion::V1 => {}
        }

        let order = execution_order(manifest)?;

        let mut report = ExecutionReport::default();
        for job in order {
            let fork_id = self.workspace.prepare(&job.id, &self.root)?;

            // Run the job, then ALWAYS clean up the fork (RAII/finally-style) so
            // a job failure still discards its workspace — no host accumulation.
            let job_outcome = self.run_job(job, &fork_id);
            let cleanup_outcome = self.workspace.cleanup(&fork_id, &self.root);

            // Propagate a job failure first (cleanup has already run), so a
            // failed job is never read as a pass and the graph stops loudly.
            let job_result = job_outcome?;
            let reclaimed = cleanup_outcome?;

            report.bytes_reclaimed += reclaimed;
            report.executed_jobs.push(job.id.clone());
            report.job_results.push(job_result);
        }

        Ok(report)
    }
}

// ---------------------------------------------------------------------------
// Topological ordering (pure, hermetic)
// ---------------------------------------------------------------------------

/// Resolve the manifest's `needs` DAG into a deterministic execution order via
/// Kahn's algorithm. Ready nodes are emitted in manifest input order so the
/// output is stable. Returns a loud `Err` if any `needs` references an unknown
/// job id, if a job id is duplicated, or if the graph contains a cycle.
pub fn execution_order(manifest: &CiManifest) -> Result<Vec<&Job>> {
    let n = manifest.jobs.len();

    // Index jobs by id; reject duplicates.
    let mut index: HashMap<&str, usize> = HashMap::with_capacity(n);
    for (i, job) in manifest.jobs.iter().enumerate() {
        if index.insert(job.id.as_str(), i).is_some() {
            bail!(
                "ci-executor: duplicate job id '{}' in manifest — cannot order the graph",
                job.id
            );
        }
    }

    // Compute in-degrees and the reverse adjacency (dependents of each node),
    // validating every `needs` edge points at a real job.
    let mut in_degree = vec![0usize; n];
    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (i, job) in manifest.jobs.iter().enumerate() {
        for need in &job.needs {
            let dep = *index.get(need.as_str()).ok_or_else(|| {
                anyhow::anyhow!(
                    "ci-executor: job '{}' needs unknown job id '{}' — failing loudly \
                     (dangling dependency edge)",
                    job.id,
                    need
                )
            })?;
            in_degree[i] += 1;
            dependents[dep].push(i);
        }
    }

    // Kahn: ready = in-degree-0 nodes, kept sorted by index for determinism.
    let mut ready: Vec<usize> = (0..n).filter(|&i| in_degree[i] == 0).collect();
    let mut order: Vec<&Job> = Vec::with_capacity(n);
    while !ready.is_empty() {
        // Smallest index first (manifest order tie-break).
        let i = ready.remove(0);
        order.push(&manifest.jobs[i]);
        for &d in &dependents[i] {
            in_degree[d] -= 1;
            if in_degree[d] == 0 {
                let pos = ready.binary_search(&d).unwrap_or_else(|e| e);
                ready.insert(pos, d);
            }
        }
    }

    if order.len() != n {
        bail!(
            "ci-executor: dependency cycle detected in the manifest job graph — \
             cannot compute an execution order (failing loudly, never silently)"
        );
    }

    Ok(order)
}

// ---------------------------------------------------------------------------
// Single CLI entry point
// ---------------------------------------------------------------------------

/// Read+parse a manifest JSON file and run it on the production executor.
///
/// This is the single entry the CLI calls. Jobs run in dependency order, each
/// in its own fork workspace that is discarded after the job (no host-disk
/// accumulation), with the `TestContract` enforced loudly.
pub fn run_manifest(
    path: &Path,
    root: &Path,
    base: &str,
    crun_path: &str,
) -> Result<ExecutionReport> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("ci-executor: read manifest: {}", path.display()))?;
    let manifest: CiManifest = serde_json::from_str(&raw)
        .with_context(|| format!("ci-executor: parse CiManifest: {}", path.display()))?;

    let executor = FastenvCiExecutor {
        root: root.to_path_buf(),
        substrate: ExecSubstrate {
            crun_path: crun_path.to_owned(),
            // Host-compatibility network (matches `exec`'s default); jobs that
            // need a DB/mirror reach it the same way `fastenv exec` does.
            network: GuestNetworkMode::Host,
        },
        workspace: ForkWorkspaceManager {
            base: base.to_owned(),
        },
    };
    executor.execute(&manifest)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use tempfile::TempDir;

    use crate::manifest::{
        Gate, JobClass, Language, MissingResourcePolicy, ResourceKind, ResourceRequirement,
        TestContract,
    };
    use crate::registry::{ForkEntry, QuotaMode, Registry};

    // ----- contract / manifest builders ------------------------------------

    fn hermetic_contract() -> TestContract {
        TestContract {
            min_executed_tests: 0,
            zero_tests_is_failure: false,
            on_missing_resource: MissingResourcePolicy::FailLoud,
            required_resources: vec![],
            asserts_runtime_behavior: false,
            languages: vec![],
        }
    }

    fn job(id: &str, needs: &[&str], commands: Vec<Command>, contract: TestContract) -> Job {
        Job {
            id: id.to_owned(),
            description: None,
            needs: needs.iter().map(|s| s.to_string()).collect(),
            commands,
            test_contract: contract,
            gate: Some(Gate {
                class: JobClass::FeatureCorrectness,
                blocking: true,
            }),
        }
    }

    fn cmd(program: &str, args: &[&str]) -> Command {
        Command {
            program: program.to_owned(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: BTreeMap::new(),
        }
    }

    fn manifest(name: &str, jobs: Vec<Job>) -> CiManifest {
        CiManifest {
            manifest_version: SchemaVersion::V1,
            name: name.to_owned(),
            jobs,
        }
    }

    fn golden_manifest() -> CiManifest {
        let golden = include_str!("../docs/examples/monorepo-ci.manifest.json");
        serde_json::from_str(golden).expect("golden example manifest must parse")
    }

    // ----- fakes -----------------------------------------------------------

    #[derive(Clone)]
    struct RecordedCommand {
        program: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    }

    /// Configurable substrate that records every dispatched command and returns
    /// a fixed outcome.
    struct FakeSubstrate {
        exit_code: i32,
        executed_tests: Option<u32>,
        calls: Arc<Mutex<Vec<RecordedCommand>>>,
    }

    impl FakeSubstrate {
        fn new(exit_code: i32, executed_tests: Option<u32>) -> Self {
            FakeSubstrate {
                exit_code,
                executed_tests,
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl JobSubstrate for FakeSubstrate {
        fn run_command(
            &self,
            _fork_id: &str,
            command: &Command,
            _root: &Path,
        ) -> Result<CommandOutcome> {
            self.calls.lock().unwrap().push(RecordedCommand {
                program: command.program.clone(),
                args: command.args.clone(),
                env: command.env.clone(),
            });
            Ok(CommandOutcome {
                exit_code: self.exit_code,
                executed_tests: self.executed_tests,
            })
        }
    }

    /// Workspace manager that records prepare/cleanup calls and returns a fixed
    /// reclaimed-bytes figure per cleanup. Touches no disk.
    struct FakeWorkspace {
        prepared: Arc<Mutex<Vec<String>>>,
        cleaned: Arc<Mutex<Vec<String>>>,
        bytes_each: u64,
    }

    impl FakeWorkspace {
        fn new(bytes_each: u64) -> Self {
            FakeWorkspace {
                prepared: Arc::new(Mutex::new(Vec::new())),
                cleaned: Arc::new(Mutex::new(Vec::new())),
                bytes_each,
            }
        }
    }

    impl WorkspaceManager for FakeWorkspace {
        fn prepare(&self, job_id: &str, _root: &Path) -> Result<String> {
            let fork_id = format!("fork-{job_id}");
            self.prepared.lock().unwrap().push(fork_id.clone());
            Ok(fork_id)
        }
        fn cleanup(&self, fork_id: &str, _root: &Path) -> Result<u64> {
            self.cleaned.lock().unwrap().push(fork_id.to_owned());
            Ok(self.bytes_each)
        }
    }

    /// Hermetic workspace manager that inserts a plain-dir fork (no overlayfs
    /// mount) into the registry — the boundary.rs pattern — so the REAL
    /// `ExecSubstrate` at `crun_path=/bin/true` can drive `exec::run_exec` end
    /// to end without root or crun.
    struct DirWorkspace;

    impl WorkspaceManager for DirWorkspace {
        fn prepare(&self, job_id: &str, root: &Path) -> Result<String> {
            let fork_id = format!("ci-{}", sanitize_fork_id(job_id));
            let fork_dir = root.join("forks").join(&fork_id);
            let upper = fork_dir.join("upper");
            let work = fork_dir.join("work");
            let merged = fork_dir.join("merged");
            std::fs::create_dir_all(&upper)?;
            std::fs::create_dir_all(&work)?;
            std::fs::create_dir_all(&merged)?;
            let registry = Registry::open(root)?;
            registry.insert_fork(
                &fork_id,
                ForkEntry {
                    base_key: "base".to_owned(),
                    upper_path: upper,
                    work_path: work,
                    merged_path: Some(merged),
                    quota_bytes: None,
                    quota_mode: QuotaMode::Soft,
                    created_at: "2026-01-01T00:00:00Z".to_owned(),
                    labels: HashMap::new(),
                },
            )?;
            Ok(fork_id)
        }
        fn cleanup(&self, fork_id: &str, root: &Path) -> Result<u64> {
            let registry = Registry::open(root)?;
            let reclaimed = registry
                .get_fork(fork_id)
                .ok()
                .map(|e| du::walk_upper_bytes(&e.upper_path).unwrap_or(0))
                .unwrap_or(0);
            discard::discard_fork(fork_id, root)?;
            Ok(reclaimed)
        }
    }

    // ----- ordering tests --------------------------------------------------

    #[test]
    fn respects_dependency_order() {
        // A custom A -> B -> C chain (declared out of order).
        let m = manifest(
            "chain",
            vec![
                job("C", &["B"], vec![cmd("true", &[])], hermetic_contract()),
                job("A", &[], vec![cmd("true", &[])], hermetic_contract()),
                job("B", &["A"], vec![cmd("true", &[])], hermetic_contract()),
            ],
        );
        let order: Vec<&str> = execution_order(&m)
            .unwrap()
            .iter()
            .map(|j| j.id.as_str())
            .collect();
        let pos = |id: &str| order.iter().position(|x| *x == id).unwrap();
        assert!(pos("A") < pos("B"), "A must precede B: {order:?}");
        assert!(pos("B") < pos("C"), "B must precede C: {order:?}");

        // The golden 4-job graph: build precedes both rust suites.
        let golden = golden_manifest();
        let gorder: Vec<&str> = execution_order(&golden)
            .unwrap()
            .iter()
            .map(|j| j.id.as_str())
            .collect();
        let gpos = |id: &str| gorder.iter().position(|x| *x == id).unwrap();
        assert!(gpos("build") < gpos("rust-workspace-tests"));
        assert!(gpos("build") < gpos("rust-db-tests"));
    }

    #[test]
    fn cycle_detected_fails_loud() {
        let m = manifest(
            "cyclic",
            vec![
                job("A", &["B"], vec![], hermetic_contract()),
                job("B", &["A"], vec![], hermetic_contract()),
            ],
        );
        let err = execution_order(&m).expect_err("cycle must be rejected");
        assert!(
            err.to_string().contains("cycle"),
            "error must mention a cycle, got: {err}"
        );
    }

    #[test]
    fn missing_needs_edge_fails_loud() {
        let m = manifest(
            "dangling",
            vec![job("A", &["ghost"], vec![], hermetic_contract())],
        );
        let err = execution_order(&m).expect_err("dangling edge must be rejected");
        assert!(
            err.to_string().contains("unknown job id"),
            "error must name the unknown edge, got: {err}"
        );
    }

    // ----- TestContract enforcement ----------------------------------------

    fn run_with(
        m: &CiManifest,
        substrate: FakeSubstrate,
        ws: FakeWorkspace,
    ) -> Result<ExecutionReport> {
        let exec = FastenvCiExecutor {
            root: PathBuf::from("/var/lib/fastenv-unused"),
            substrate,
            workspace: ws,
        };
        exec.execute(m)
    }

    #[test]
    fn zero_tests_is_failure_enforced() {
        let contract = TestContract {
            min_executed_tests: 0,
            zero_tests_is_failure: true,
            ..hermetic_contract()
        };
        let m = manifest("z", vec![job("t", &[], vec![cmd("true", &[])], contract)]);
        // Substrate reports zero executed tests with a clean exit.
        let err = run_with(&m, FakeSubstrate::new(0, Some(0)), FakeWorkspace::new(0))
            .expect_err("zero tests with zero_tests_is_failure must fail");
        assert!(err.to_string().contains("zero tests") || err.to_string().contains("zero"));
    }

    #[test]
    fn min_executed_tests_enforced() {
        let contract = TestContract {
            min_executed_tests: 3,
            zero_tests_is_failure: true,
            ..hermetic_contract()
        };
        let m = manifest("min", vec![job("t", &[], vec![cmd("true", &[])], contract)]);
        let err = run_with(&m, FakeSubstrate::new(0, Some(1)), FakeWorkspace::new(0))
            .expect_err("count below min_executed_tests must fail");
        assert!(err.to_string().contains("min_executed_tests"));
    }

    #[test]
    fn nonzero_exit_fails_loud_not_skipped() {
        let m = manifest(
            "fail",
            vec![job("t", &[], vec![cmd("false", &[])], hermetic_contract())],
        );
        // Exit 1 simulates a missing FailLoud resource / failing test command.
        let err = run_with(&m, FakeSubstrate::new(1, None), FakeWorkspace::new(0))
            .expect_err("non-zero exit must fail the graph");
        assert!(
            err.to_string().contains("exited with code 1"),
            "error must report the non-zero exit, got: {err}"
        );
    }

    // ----- ACT non-goal guards ---------------------------------------------

    #[test]
    fn no_act_leakage_surfaces() {
        let golden = golden_manifest();
        let substrate = FakeSubstrate::new(0, None);
        let calls = Arc::clone(&substrate.calls);
        let report = run_with(&golden, substrate, FakeWorkspace::new(0)).unwrap();
        assert_eq!(report.executed_jobs.len(), 4);

        let recorded = calls.lock().unwrap();
        assert!(!recorded.is_empty(), "the executor must dispatch commands");
        for c in recorded.iter() {
            // No host `node` dependency, no ACT runner surface.
            assert_ne!(c.program, "node", "no host node dependency allowed");
            assert!(
                !c.program.contains("act") && !c.program.contains(".actrc"),
                "no ACT runner surface allowed: {}",
                c.program
            );
            for token in c.args.iter().chain(c.env.keys()).chain(c.env.values()) {
                for forbidden in ["${{", "runs-on", "permissions", "uses:", ".actrc"] {
                    assert!(
                        !token.contains(forbidden),
                        "GHA/ACT surface '{forbidden}' leaked into a dispatched command: {token}"
                    );
                }
            }
        }
    }

    #[test]
    fn no_host_node_or_blocking_downloads() {
        // A job declaring a model_weights resource with FailLoud must NOT cause
        // the executor to inject a download/fetch step or a `node` invocation —
        // it dispatches exactly the job's declared commands.
        let contract = TestContract {
            min_executed_tests: 1,
            zero_tests_is_failure: true,
            on_missing_resource: MissingResourcePolicy::FailLoud,
            required_resources: vec![ResourceRequirement {
                kind: ResourceKind::ModelWeights,
                name: "nexum-weights".to_owned(),
            }],
            asserts_runtime_behavior: true,
            languages: vec![Language::Rust],
        };
        let declared = vec![cmd("cargo", &["nextest", "run"])];
        let m = manifest(
            "weights",
            vec![job("model-tests", &[], declared.clone(), contract)],
        );
        let substrate = FakeSubstrate::new(0, Some(2));
        let calls = Arc::clone(&substrate.calls);
        run_with(&m, substrate, FakeWorkspace::new(0)).unwrap();

        let recorded = calls.lock().unwrap();
        assert_eq!(
            recorded.len(),
            declared.len(),
            "executor must dispatch ONLY the declared commands (no injected download step)"
        );
        for c in recorded.iter() {
            assert_ne!(c.program, "node");
            for token in std::iter::once(&c.program).chain(c.args.iter()) {
                for forbidden in ["download", "fetch", "wget", "curl", "huggingface"] {
                    assert!(
                        !token.contains(forbidden),
                        "no blocking-download command may be injected: {token}"
                    );
                }
            }
        }
    }

    #[test]
    fn cleans_up_workspaces_no_accumulation() {
        // Success path: every prepared fork is cleaned and bytes accumulate.
        let m = manifest(
            "two",
            vec![
                job("a", &[], vec![cmd("true", &[])], hermetic_contract()),
                job("b", &[], vec![cmd("true", &[])], hermetic_contract()),
            ],
        );
        let ws = FakeWorkspace::new(100);
        let prepared = Arc::clone(&ws.prepared);
        let cleaned = Arc::clone(&ws.cleaned);
        let report = run_with(&m, FakeSubstrate::new(0, None), ws).unwrap();
        assert_eq!(prepared.lock().unwrap().len(), 2);
        assert_eq!(
            *prepared.lock().unwrap(),
            *cleaned.lock().unwrap(),
            "every prepared fork must be cleaned up"
        );
        assert_eq!(
            report.bytes_reclaimed, 200,
            "reclaimed bytes must accumulate"
        );

        // Failure path: a failing job's fork is STILL cleaned up.
        let ws2 = FakeWorkspace::new(50);
        let prepared2 = Arc::clone(&ws2.prepared);
        let cleaned2 = Arc::clone(&ws2.cleaned);
        let _ = run_with(&m, FakeSubstrate::new(1, None), ws2)
            .expect_err("a failing command must error the graph");
        assert!(
            !prepared2.lock().unwrap().is_empty(),
            "at least one fork was prepared"
        );
        assert_eq!(
            *prepared2.lock().unwrap(),
            *cleaned2.lock().unwrap(),
            "even on failure, every prepared fork must be cleaned up (no accumulation)"
        );
    }

    // ----- real, hermetic end-to-end ---------------------------------------

    /// Drives the REAL `ExecSubstrate` -> `exec::run_exec` -> OCI config gen ->
    /// CrunBackend create/start/delete pipeline with `crun_path=/bin/true`
    /// (the boundary.rs hermetic pattern). Runs for real in CI; no root/crun.
    #[test]
    fn runs_sample_manifest_end_to_end() {
        let root = TempDir::new().unwrap();
        // Initialise the registry so forks can be inserted.
        let _ = Registry::open(root.path()).unwrap();

        let executor = FastenvCiExecutor {
            root: root.path().to_path_buf(),
            substrate: ExecSubstrate {
                crun_path: "/bin/true".to_owned(),
                network: GuestNetworkMode::Host,
            },
            workspace: DirWorkspace,
        };

        let report = executor.execute(&golden_manifest()).unwrap();

        assert_eq!(report.executed_jobs.len(), 4, "all four jobs must run");
        assert_eq!(report.job_results.len(), 4);
        for jr in &report.job_results {
            assert!(jr.passed, "job '{}' must pass", jr.id);
            assert_eq!(jr.exit_code, 0, "job '{}' must exit 0", jr.id);
            assert!(jr.commands_run > 0, "job '{}' must run >0 commands", jr.id);
        }
        // build precedes both rust suites in the executed order.
        let pos = |id: &str| report.executed_jobs.iter().position(|x| x == id).unwrap();
        assert!(pos("build") < pos("rust-workspace-tests"));
        assert!(pos("build") < pos("rust-db-tests"));
    }

    #[test]
    fn unimplemented_executor_is_a_trait_object() {
        // The #821 seam guarantee: still referenceable as a trait object.
        let _stub: Box<dyn CiExecutor> = Box::new(UnimplementedExecutor);
    }
}
