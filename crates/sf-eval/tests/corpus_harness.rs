//! Hermetic subprocess tests for the Tier-2 corpus harness driver (issue
//! #863): `sf-eval corpus` invoked as the **built binary**, never the library
//! functions directly, so a real CLI-parsing + process-exit-code regression
//! would be caught (test-coverage invariant 2 — "no tests collected" style
//! blind spots).
//!
//! Every test here is hermetic: no live model, no database, no network beyond
//! a loopback TCP probe against a locally bound-then-dropped ephemeral port
//! (a deterministic, offline "closed port"). Per test-coverage invariant 1,
//! an unreachable resource fails loud (non-zero exit, a recorded
//! `endpoint_unreachable` verdict), never a silent skip.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;

use sf_eval::CorpusResult;

fn sf_eval_bin() -> &'static str {
    env!("CARGO_BIN_EXE_sf-eval")
}

fn fixture_corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/corpus")
}

fn fake_scenario_runner() -> PathBuf {
    fixture_corpus_root().join("fake_scenario_runner.sh")
}

/// The real, committed `evals/scenarios/` tree (repo-root relative), proving
/// discovery against the actual corpus, not just synthetic fixtures.
fn repo_scenarios_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../evals/scenarios")
}

/// A deterministic, network-free "unreachable" address: bind an ephemeral
/// port, read it back, then drop the listener — nothing is listening on it
/// for the immediately-following connect attempt.
fn unreachable_addr() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().expect("local addr").port();
    drop(listener);
    format!("127.0.0.1:{port}")
}

fn copy_dir_recursive(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).expect("create dst dir");
    for entry in std::fs::read_dir(src).expect("read src dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &target);
        } else {
            std::fs::copy(&path, &target).expect("copy fixture file");
        }
    }
}

fn read_corpus_result(results_root: &Path) -> CorpusResult {
    let raw = std::fs::read_to_string(results_root.join("corpus-result.json"))
        .expect("aggregate corpus-result.json written");
    serde_json::from_str(&raw).expect("aggregate result.json parses as CorpusResult")
}

#[test]
fn corpus_enumeration_discovers_committed_scenarios() {
    // Force the endpoint precheck to fail fast (no live model needed) — this
    // still exercises discovery, which runs before the precheck.
    let results = tempfile::tempdir().expect("tempdir");
    let output = Command::new(sf_eval_bin())
        .arg("corpus")
        .arg("--scenarios-root")
        .arg(repo_scenarios_root())
        .arg("--results-root")
        .arg(results.path())
        .arg("--endpoint-health-addr")
        .arg(unreachable_addr())
        .output()
        .expect("spawn sf-eval corpus");

    assert!(
        !output.status.success(),
        "an unreachable endpoint must exit non-zero: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let parsed = read_corpus_result(results.path());
    let mut names: Vec<&str> = parsed
        .scenarios
        .iter()
        .map(|s| s.scenario.as_str())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec!["todo-app"],
        "discovers exactly the scenario directories committed under evals/scenarios/"
    );
}

#[test]
fn mixed_corpus_exits_nonzero_and_names_failing_stage() {
    let results = tempfile::tempdir().expect("tempdir");
    let output = Command::new(sf_eval_bin())
        .arg("corpus")
        .arg("--scenarios-root")
        .arg(fixture_corpus_root())
        .arg("--results-root")
        .arg(results.path())
        .arg("--scenario-cmd")
        .arg(fake_scenario_runner())
        .output()
        .expect("spawn sf-eval corpus");

    assert!(
        !output.status.success(),
        "a corpus with one red scenario must exit non-zero"
    );

    let parsed = read_corpus_result(results.path());
    assert_eq!(parsed.exit_code(), 1);
    assert!(!parsed.all_green());
    assert_eq!(
        parsed.scenarios.len(),
        2,
        "exactly one verdict per scenario"
    );

    let red = parsed
        .scenarios
        .iter()
        .find(|s| s.scenario == "red-scenario")
        .expect("red-scenario verdict present");
    assert!(!red.green);
    assert_eq!(red.failing_stage.as_deref(), Some("rungs"));

    let green = parsed
        .scenarios
        .iter()
        .find(|s| s.scenario == "green-scenario")
        .expect("green-scenario verdict present");
    assert!(green.green);
    assert!(green.failing_stage.is_none());
}

#[test]
fn all_green_corpus_exits_zero_with_parseable_aggregate() {
    // Build a corpus containing only the committed green-scenario fixture, so
    // "all green" is exercised without a red scenario in the mix.
    let scenarios_tmp = tempfile::tempdir().expect("tempdir");
    copy_dir_recursive(
        &fixture_corpus_root().join("green-scenario"),
        &scenarios_tmp.path().join("green-scenario"),
    );

    let results = tempfile::tempdir().expect("tempdir");
    let output = Command::new(sf_eval_bin())
        .arg("corpus")
        .arg("--scenarios-root")
        .arg(scenarios_tmp.path())
        .arg("--results-root")
        .arg(results.path())
        .arg("--scenario-cmd")
        .arg(fake_scenario_runner())
        .output()
        .expect("spawn sf-eval corpus");

    assert!(
        output.status.success(),
        "an all-green corpus must exit 0: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let parsed = read_corpus_result(results.path());
    assert!(parsed.all_green());
    assert_eq!(parsed.exit_code(), 0);
    assert_eq!(parsed.scenarios.len(), 1);
    assert_eq!(parsed.scenarios[0].scenario, "green-scenario");
    assert!(parsed.scenarios[0].green);
    assert!(parsed.scenarios[0].failing_stage.is_none());

    // Serde round-trip through the exact bytes on disk.
    let roundtrip: CorpusResult = serde_json::from_str(&parsed.to_json()).expect("round-trips");
    assert_eq!(roundtrip, parsed);
}

#[test]
fn unreachable_model_endpoint_fails_loud() {
    let results = tempfile::tempdir().expect("tempdir");
    let output = Command::new(sf_eval_bin())
        .arg("corpus")
        .arg("--scenarios-root")
        .arg(fixture_corpus_root())
        .arg("--results-root")
        .arg(results.path())
        .arg("--endpoint-health-addr")
        .arg(unreachable_addr())
        // Deliberately no --scenario-cmd: the endpoint precheck must
        // short-circuit before any scenario is attempted.
        .output()
        .expect("spawn sf-eval corpus");

    assert!(
        !output.status.success(),
        "an unreachable model endpoint must exit non-zero"
    );

    let parsed = read_corpus_result(results.path());
    assert!(!parsed.all_green());
    assert!(
        !parsed.scenarios.is_empty(),
        "the fixture corpus is non-empty"
    );
    for verdict in &parsed.scenarios {
        assert!(
            !verdict.green,
            "no green verdict is permitted when the model endpoint is unreachable"
        );
        assert_eq!(
            verdict.failing_stage.as_deref(),
            Some("endpoint_unreachable"),
            "a red verdict from an unreachable endpoint must name the stage"
        );
    }
}
