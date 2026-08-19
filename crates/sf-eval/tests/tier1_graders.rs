//! Tier-1 grader fixture-corpus stub (issue #871 scout, downstream #866).
//!
//! `docs/eval-design.md` sequencing item 3 makes replayed Tier-1 graders the
//! per-PR regression net. This stub pins the fixture corpus layout under
//! `tests/fixtures/tier1/` (see its `README.md`) and proves the two graders
//! with a deterministic no-model mode — `project-graph` (structural
//! fallback) and `compiling-candidate` (count-based) — verdict correctly
//! against artifact-shaped recorded samples, not just the ad hoc
//! strings/counts `src/graders.rs`'s own unit tests use.
//!
//! This is intentionally the fixture-corpus seam only: the full per-grader
//! matrix (including a `malformed.*` sample proving "FAIL without panic") and
//! the required `eval-tier1.yml` workflow are #866's scope, not this scout's.
//! A zero-collection run here would be a silent hole in Tier-1's coverage —
//! `--no-tests=fail` (this crate's workspace default, see `.config/nextest.toml`)
//! makes that hard-fail rather than pass quietly.

use sf_eval::{compiling_candidate_pass, project_graph_pass};
use std::path::{Path, PathBuf};

/// The `todo-app` scenario's expected verbs — the same parameterization
/// `crates/sf-eval/src/main.rs`'s live runner passes to `project_graph_pass`.
const TODO_VERBS: &[&str] = &["add", "list", "complete"];

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tier1")
}

fn read_fixture(relative: &str) -> String {
    let path = fixture_root().join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()))
}

#[test]
fn project_graph_passing_fixture_verdicts_pass() {
    let graph_md = read_fixture("project-graph/passing.md");
    assert!(
        project_graph_pass(&graph_md, TODO_VERBS),
        "passing.md must verdict PASS: mentions task/todo and all expected verbs"
    );
}

#[test]
fn project_graph_regressed_fixture_verdicts_fail() {
    let graph_md = read_fixture("project-graph/regressed.md");
    assert!(
        !project_graph_pass(&graph_md, TODO_VERBS),
        "regressed.md is missing the 'complete' verb and must verdict FAIL"
    );
}

#[test]
fn compiling_candidate_passing_fixture_verdicts_pass() {
    let raw = read_fixture("compiling-candidate/passing.json");
    let payloads: Vec<serde_json::Value> =
        serde_json::from_str(&raw).expect("passing.json parses as a JSON array");
    assert!(
        compiling_candidate_pass(payloads.len() as u64),
        "passing.json carries a recorded merge_result and must verdict PASS"
    );
}

#[test]
fn compiling_candidate_regressed_fixture_verdicts_fail() {
    let raw = read_fixture("compiling-candidate/regressed.json");
    let payloads: Vec<serde_json::Value> =
        serde_json::from_str(&raw).expect("regressed.json parses as a JSON array");
    assert!(
        !compiling_candidate_pass(payloads.len() as u64),
        "regressed.json records no merge_result and must verdict FAIL"
    );
}
