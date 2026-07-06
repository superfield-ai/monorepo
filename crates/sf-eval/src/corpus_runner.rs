//! Tier-2 corpus harness driver (issue #863).
//!
//! Enumerates the scenario corpus under `evals/scenarios/` (via
//! [`crate::discover_scenarios`], pinned by the dev-scout, issue #870) and runs
//! each discovered scenario through the whole gardening loop **sequentially**
//! against the live model endpoint, producing one [`ScenarioVerdict`] per
//! scenario aggregated into a [`CorpusResult`] envelope (also #870). See
//! [`evals/runners/live.md`](../../../../evals/runners/live.md) and
//! [`evals/README.md`](../../../../evals/README.md) for the operator-facing
//! description of the `sf-eval corpus` invocation this module backs.
//!
//! # Per-scenario execution is pluggable
//!
//! Production wiring seeds the scenario's intent (`superfield garden
//! <scenario>/seed/*.md --workspace-id <id>`) against the already-booted
//! appliance (boot + the deterministic-floor/poll/grade/emit pipeline stay the
//! job of the already-running `superfield serve` + this same binary's `run`
//! subcommand — this driver does not spawn a fresh appliance per scenario;
//! there is one shared, already-running appliance for the whole corpus run).
//! "Reset" is implicit: each scenario gets a **fresh workspace id**, so there
//! is no shared state to clear between scenarios.
//!
//! Tests substitute [`CorpusConfig::scenario_cmd`] — a fixture executable
//! invoked as `<cmd> <scenario-dir> <workspace-id> <results-root>` that prints
//! a `result.json`-shaped [`crate::RunResult`] to stdout and exits 0/non-zero —
//! so the aggregation, exit-code, failing-stage-naming, and enumeration
//! behaviour is exercised hermetically (test-coverage invariant 1: no live
//! model or database needed to prove the harness's own logic).

use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use uuid::Uuid;

use crate::corpus::{discover_scenarios, CorpusResult, ScenarioDescriptor, ScenarioVerdict};
use crate::result::RunResult;

/// The aggregate corpus `result.json` envelope's filename, written directly
/// under `results_root` (distinct from the per-scenario `result.json` files
/// under `results_root/<scenario>/<workspace-id>/`, issue #780).
pub const CORPUS_RESULT_FILENAME: &str = "corpus-result.json";

/// Configuration for one `sf-eval corpus` invocation.
#[derive(Debug, Clone)]
pub struct CorpusConfig {
    /// Root directory to enumerate scenarios under (`evals/scenarios/`).
    pub scenarios_root: PathBuf,
    /// Root directory results are written under (`evals/results/`).
    pub results_root: PathBuf,
    /// Turn budget handed to each scenario's live runner invocation.
    pub turn_budget: u32,
    /// Poll interval (seconds) handed to each scenario's live runner invocation.
    pub poll_interval_secs: u64,
    /// When set, a TCP-reachability precheck against this `host:port` runs
    /// before any scenario executes. Unreachable fails the **whole** corpus
    /// loud (every discovered scenario recorded red, `endpoint_unreachable`)
    /// rather than attempting scenarios against a dead model endpoint.
    pub endpoint_health_addr: Option<String>,
    /// Timeout for the endpoint-reachability precheck.
    pub endpoint_timeout: Duration,
    /// Override the per-scenario execution command (tests only — production
    /// runs use the default seed+run pipeline). See module docs.
    pub scenario_cmd: Option<PathBuf>,
}

impl Default for CorpusConfig {
    fn default() -> Self {
        Self {
            scenarios_root: PathBuf::from("evals/scenarios"),
            results_root: PathBuf::from("evals/results"),
            turn_budget: 60,
            poll_interval_secs: 5,
            endpoint_health_addr: None,
            endpoint_timeout: Duration::from_millis(2000),
            scenario_cmd: None,
        }
    }
}

/// The outcome of one `run_corpus` call: the aggregate envelope plus the
/// process exit code the binary should use.
#[derive(Debug, Clone)]
pub struct CorpusOutcome {
    pub result: CorpusResult,
    pub exit_code: i32,
}

/// Run the whole corpus: discover, precheck the model endpoint, run every
/// scenario sequentially, aggregate, write the envelope, and derive the exit
/// code.
///
/// Never fabricates a green verdict: a discovery failure, an empty corpus, or
/// an unreachable model endpoint all force a non-zero exit even though
/// [`CorpusResult::exit_code`] alone would treat zero scenarios as vacuously
/// green (that pure rollup only owns the envelope shape — this driver owns the
/// "zero scenarios executed must fail" and "dead endpoint must fail" policies,
/// per the envelope's own doc comment).
pub fn run_corpus(cfg: CorpusConfig) -> CorpusOutcome {
    let scenarios = match discover_scenarios(&cfg.scenarios_root) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "sf-eval corpus: scenario discovery FAILED under {}: {e}",
                cfg.scenarios_root.display()
            );
            return CorpusOutcome {
                result: CorpusResult { scenarios: vec![] },
                exit_code: 1,
            };
        }
    };

    if scenarios.is_empty() {
        eprintln!(
            "sf-eval corpus: no scenarios discovered under {} — failing loud, never a vacuous green",
            cfg.scenarios_root.display()
        );
        let result = CorpusResult { scenarios: vec![] };
        write_corpus_result(&result, &cfg.results_root);
        return CorpusOutcome {
            result,
            exit_code: 1,
        };
    }

    if let Some(addr) = &cfg.endpoint_health_addr {
        if !endpoint_reachable(addr, cfg.endpoint_timeout) {
            eprintln!(
                "sf-eval corpus: model endpoint {addr} UNREACHABLE — failing every \
                 discovered scenario loud (no skip, no fake green)"
            );
            let verdicts = scenarios
                .iter()
                .map(|s| ScenarioVerdict::red(&s.name, "endpoint_unreachable"))
                .collect();
            let result = CorpusResult {
                scenarios: verdicts,
            };
            write_corpus_result(&result, &cfg.results_root);
            return CorpusOutcome {
                result,
                exit_code: 1,
            };
        }
    }

    let mut verdicts = Vec::with_capacity(scenarios.len());
    for descriptor in &scenarios {
        eprintln!("sf-eval corpus: running scenario {}", descriptor.name);
        let workspace_id = Uuid::new_v4();
        let verdict = run_one_scenario(descriptor, workspace_id, &cfg);
        eprintln!(
            "sf-eval corpus: scenario {} verdict: {}",
            descriptor.name,
            if verdict.green { "GREEN" } else { "RED" }
        );
        verdicts.push(verdict);
    }

    let result = CorpusResult {
        scenarios: verdicts,
    };
    write_corpus_result(&result, &cfg.results_root);
    let exit_code = result.exit_code();
    CorpusOutcome { result, exit_code }
}

/// A short-timeout TCP reachability probe. Used both for the real model
/// endpoint (e.g. the keyless `opencode serve` health port) and, in tests, for
/// a guaranteed-closed local port — deterministic and hermetic either way (no
/// external network dependency is required to prove the *harness's* handling
/// of an unreachable endpoint).
fn endpoint_reachable(addr: &str, timeout: Duration) -> bool {
    let Ok(mut addrs) = addr.to_socket_addrs() else {
        return false;
    };
    let Some(sock_addr) = addrs.next() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&sock_addr, timeout).is_ok()
}

/// Run one scenario, dispatching to the test override or the production
/// seed+run pipeline.
fn run_one_scenario(
    descriptor: &ScenarioDescriptor,
    workspace_id: Uuid,
    cfg: &CorpusConfig,
) -> ScenarioVerdict {
    if let Some(cmd) = &cfg.scenario_cmd {
        let output = Command::new(cmd)
            .arg(&descriptor.path)
            .arg(workspace_id.to_string())
            .arg(&cfg.results_root)
            .output();
        return finalize_from_output(&descriptor.name, output);
    }
    default_seed_and_run(descriptor, workspace_id, cfg)
}

/// Production per-scenario pipeline: seed the intent via the `superfield`
/// binary, then re-invoke this binary's own `run` subcommand (the deterministic
/// floor + poll/grade/emit live runner, issue #748) against the already-running
/// appliance.
fn default_seed_and_run(
    descriptor: &ScenarioDescriptor,
    workspace_id: Uuid,
    cfg: &CorpusConfig,
) -> ScenarioVerdict {
    let superfield_bin = locate_superfield_bin();
    let mut seed_cmd = Command::new(&superfield_bin);
    seed_cmd.arg("garden");
    for seed_file in &descriptor.seed_files {
        seed_cmd.arg(seed_file);
    }
    seed_cmd.arg("--workspace-id").arg(workspace_id.to_string());

    match seed_cmd.status() {
        Ok(status) if status.success() => {}
        Ok(status) => {
            eprintln!(
                "sf-eval corpus: seed FAILED for {} (superfield garden exit {status})",
                descriptor.name
            );
            return ScenarioVerdict::red(&descriptor.name, "seed");
        }
        Err(e) => {
            eprintln!(
                "sf-eval corpus: could not spawn {} garden for {}: {e}",
                superfield_bin.display(),
                descriptor.name
            );
            return ScenarioVerdict::red(&descriptor.name, "seed");
        }
    }

    let self_bin = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("sf-eval"));
    let output = Command::new(self_bin)
        .arg("run")
        .arg("--scenario")
        .arg(&descriptor.path)
        .arg("--turn-budget")
        .arg(cfg.turn_budget.to_string())
        .arg("--workspace-id")
        .arg(workspace_id.to_string())
        .arg("--poll-interval-secs")
        .arg(cfg.poll_interval_secs.to_string())
        .arg("--results-root")
        .arg(&cfg.results_root)
        .output();

    finalize_from_output(&descriptor.name, output)
}

/// Locate the `superfield` binary: `SF_EVAL_SUPERFIELD_BIN` env override, else
/// a sibling of the current executable (both binaries land in the same
/// `target/<profile>/` directory), else bare `superfield` resolved via `PATH`.
fn locate_superfield_bin() -> PathBuf {
    if let Ok(p) = std::env::var("SF_EVAL_SUPERFIELD_BIN") {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("superfield");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("superfield")
}

/// Turn a completed (or failed-to-spawn) scenario-runner process into a
/// [`ScenarioVerdict`], naming the failing stage.
fn finalize_from_output(
    name: &str,
    output: std::io::Result<std::process::Output>,
) -> ScenarioVerdict {
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            verdict_from_run_result_json(name, &stdout)
        }
        Err(e) => {
            eprintln!("sf-eval corpus: could not run scenario {name}: {e}");
            ScenarioVerdict::red(name, "process_error")
        }
    }
}

/// The pure failing-stage-selection rule: parse a scenario runner's stdout as
/// a [`RunResult`] and derive its [`ScenarioVerdict`].
///
/// - Unparseable stdout (crash, no output, corrupt JSON) — `"process_error"`.
/// - A failed deterministic floor — `"deterministic_floor"` (a broken offline
///   resource, never conflated with a live-loop acceptance miss).
/// - A passed floor but unmet gating acceptance rungs — `"rungs"`.
/// - Otherwise — green.
///
/// Factored out as a pure `&str -> ScenarioVerdict` function (no process I/O)
/// so the rollup/failing-stage-selection logic is unit-tested directly,
/// alongside the existing #849 orchestration coverage.
pub fn verdict_from_run_result_json(name: &str, stdout: &str) -> ScenarioVerdict {
    match serde_json::from_str::<RunResult>(stdout.trim()) {
        Ok(r) if !r.deterministic.all_pass() => ScenarioVerdict::red(name, "deterministic_floor"),
        Ok(r) if !r.accepted => ScenarioVerdict::red(name, "rungs"),
        Ok(_) => ScenarioVerdict::green(name),
        Err(_) => ScenarioVerdict::red(name, "process_error"),
    }
}

fn write_corpus_result(result: &CorpusResult, results_root: &Path) {
    if let Err(e) = std::fs::create_dir_all(results_root) {
        eprintln!(
            "sf-eval corpus: cannot create results root {}: {e}",
            results_root.display()
        );
        return;
    }
    let path = results_root.join(CORPUS_RESULT_FILENAME);
    if let Err(e) = std::fs::write(&path, result.to_json()) {
        eprintln!("sf-eval corpus: failed to write {}: {e}", path.display());
        return;
    }
    eprintln!("sf-eval corpus: wrote {}", path.display());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::result::{Acceptance, DeterministicRungs};

    fn passing_run_result(scenario: &str) -> RunResult {
        RunResult {
            scenario: scenario.to_string(),
            workspace_id: "ws-1".to_string(),
            accepted: true,
            turns_to_acceptable: Some(3),
            turns_used: 3,
            turn_budget: 10,
            page_revisions: 2,
            rungs: Acceptance {
                project_graph: true,
                compiling_candidate: true,
            },
            deterministic: DeterministicRungs {
                seed: true,
                ingest: true,
                semantic_search: true,
            },
            elapsed_seconds: 5,
            browser_smoke: "skipped".into(),
        }
    }

    // ── verdict_from_run_result_json (pure failing-stage selection) ─────────

    #[test]
    fn verdict_from_run_result_json_green_on_accepted_result() {
        let result = passing_run_result("todo-app");
        let verdict = verdict_from_run_result_json("todo-app", &result.to_json());
        assert!(verdict.green);
        assert!(verdict.failing_stage.is_none());
    }

    #[test]
    fn verdict_from_run_result_json_names_rungs_when_floor_passes_but_unaccepted() {
        let mut result = passing_run_result("todo-app");
        result.accepted = false;
        result.rungs.compiling_candidate = false;
        let verdict = verdict_from_run_result_json("todo-app", &result.to_json());
        assert!(!verdict.green);
        assert_eq!(verdict.failing_stage.as_deref(), Some("rungs"));
    }

    #[test]
    fn verdict_from_run_result_json_names_deterministic_floor_on_broken_floor() {
        let mut result = passing_run_result("todo-app");
        result.accepted = false;
        result.deterministic.semantic_search = false;
        let verdict = verdict_from_run_result_json("todo-app", &result.to_json());
        assert!(!verdict.green);
        assert_eq!(
            verdict.failing_stage.as_deref(),
            Some("deterministic_floor")
        );
    }

    #[test]
    fn verdict_from_run_result_json_names_process_error_on_unparseable_stdout() {
        let verdict = verdict_from_run_result_json("todo-app", "not json at all");
        assert!(!verdict.green);
        assert_eq!(verdict.failing_stage.as_deref(), Some("process_error"));
    }

    #[test]
    fn verdict_from_run_result_json_names_process_error_on_empty_stdout() {
        let verdict = verdict_from_run_result_json("todo-app", "");
        assert!(!verdict.green);
        assert_eq!(verdict.failing_stage.as_deref(), Some("process_error"));
    }

    // ── endpoint_reachable (hermetic: a bound-then-dropped ephemeral port is a
    // deterministic, network-free "closed port", so this needs no external
    // resource) ───────────────────────────────────────────────────────────────

    #[test]
    fn endpoint_reachable_is_false_for_a_closed_local_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        let addr = format!("127.0.0.1:{port}");
        assert!(!endpoint_reachable(&addr, Duration::from_millis(200)));
    }

    #[test]
    fn endpoint_reachable_is_true_for_a_listening_local_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local addr").to_string();
        // Keep the listener alive for the duration of the probe.
        assert!(endpoint_reachable(&addr, Duration::from_millis(500)));
        drop(listener);
    }

    // ── run_corpus policy: empty corpus never fakes a green ─────────────────

    #[test]
    fn run_corpus_fails_loud_on_empty_scenarios_root() {
        let scenarios_root = tempfile::tempdir().expect("tempdir");
        let results_root = tempfile::tempdir().expect("tempdir");
        let cfg = CorpusConfig {
            scenarios_root: scenarios_root.path().to_path_buf(),
            results_root: results_root.path().to_path_buf(),
            ..CorpusConfig::default()
        };
        let outcome = run_corpus(cfg);
        assert_eq!(
            outcome.exit_code, 1,
            "empty corpus must never vacuously pass"
        );
        assert!(outcome.result.scenarios.is_empty());
    }

    #[test]
    fn run_corpus_fails_loud_on_unreadable_scenarios_root() {
        let results_root = tempfile::tempdir().expect("tempdir");
        let cfg = CorpusConfig {
            scenarios_root: PathBuf::from("/nonexistent/does-not-exist-863"),
            results_root: results_root.path().to_path_buf(),
            ..CorpusConfig::default()
        };
        let outcome = run_corpus(cfg);
        assert_eq!(outcome.exit_code, 1);
        assert!(outcome.result.scenarios.is_empty());
    }
}
