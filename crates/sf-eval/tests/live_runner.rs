//! Acceptance test for the Tier-2 live runner (issue #748).
//!
//! Asserts the runner produces a `result.json` containing `turns_to_acceptable`
//! and per-rung pass/fail for a seeded run, driven from a fixture
//! `gardening_cursor` sequence (no live model or database).

use sf_eval::{compiling_candidate_pass, evaluate_run, project_graph_pass, Acceptance, RunResult};
use sf_loop::STEP_ORDER;

/// A fixture `orchestrator.gardening_cursor` observation sequence for a seeded
/// run: one full nine-step pass, then the next pass advances far enough to land
/// a compiling candidate again. Repeats simulate the runner polling faster than
/// the loop advances (collapsed by the turn counter).
fn fixture_cursor_sequence() -> Vec<String> {
    let mut seq: Vec<String> = Vec::new();
    // First full pass, with a couple of repeated polls per step.
    for step in STEP_ORDER {
        seq.push(step.name().to_string());
        seq.push(step.name().to_string());
    }
    // The acceptance graders pass once project_graph_derive + code_change_proposal
    // have run in this pass, so the run stops at the end of pass 1.
    seq
}

#[test]
fn live_runner_emits_result_json_with_turns() {
    let workspace_id = "11111111-1111-4111-8111-111111111111";
    let cursor_seq = fixture_cursor_sequence();

    // Grade the (fixture) loop output. Rung 1: a derived project graph that
    // describes add/list/complete. Rung 2: a compiling candidate exists.
    let project_graph_md =
        "# Todo tracker\n- Feature: Add a task\n- Feature: List tasks\n- Feature: Complete a task";
    let acceptance = Acceptance {
        project_graph: project_graph_pass(project_graph_md, &["add", "list", "complete"]),
        // One merge_result event observed in the Sharp episode store.
        compiling_candidate: compiling_candidate_pass(1),
    };

    let result = evaluate_run(
        "todo-app",
        workspace_id,
        &cursor_seq,
        /* turn_budget */ 60,
        /* page_revisions */ 6,
        acceptance,
        /* browser_smoke */ "pass",
    );

    // The result carries the headline turn metric and per-rung pass/fail.
    assert!(result.accepted, "both gating rungs passed");
    assert_eq!(
        result.turns_to_acceptable,
        Some(STEP_ORDER.len() as u32),
        "turns_to_acceptable equals one full pass over STEP_ORDER"
    );
    assert!(result.rungs.project_graph);
    assert!(result.rungs.compiling_candidate);

    // Emit result.json under a temp results root and read it back.
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = result.write_under(tmp.path()).expect("write result.json");
    assert!(path.ends_with("todo-app/11111111-1111-4111-8111-111111111111/result.json"));

    let written = std::fs::read_to_string(&path).expect("read result.json");
    let parsed: serde_json::Value = serde_json::from_str(&written).expect("valid json");

    assert_eq!(parsed["scenario"], "todo-app");
    assert_eq!(parsed["turns_to_acceptable"], STEP_ORDER.len() as u64);
    assert_eq!(parsed["accepted"], true);
    assert_eq!(parsed["rungs"]["project_graph"], true);
    assert_eq!(parsed["rungs"]["compiling_candidate"], true);
    assert_eq!(parsed["browser_smoke"], "pass");

    // Round-trips through the typed struct too.
    let typed: RunResult = serde_json::from_str(&written).expect("typed parse");
    assert_eq!(typed.turns_to_acceptable, Some(STEP_ORDER.len() as u32));
}
