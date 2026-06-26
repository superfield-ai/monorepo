//! Live runner (Tier 2) — turn counting + run evaluation.
//!
//! The live runner drives a scenario through the **real** appliance and a real
//! model (see [`evals/runners/live.md`](../../../evals/runners/live.md)). The
//! network/DB/CLI orchestration (`reset → seed → serve → poll → grade → emit`)
//! is the runner binary's job; this module holds the **pure** core the binary
//! and the tests share:
//!
//! - [`count_turns`] — turn = one completed gardening step, counted by observing
//!   the `orchestrator.gardening_cursor` advance. The runner polls the cursor and
//!   feeds the observed step-name sequence here; the count is the number of
//!   cursor advances (each commit is one finished step), robust across the loop's
//!   repeating nine-step passes.
//! - [`evaluate_run`] — fold the per-poll grader verdicts and the turn count into
//!   a [`RunResult`] (`accepted`, `turns_to_acceptable`), ready to emit as
//!   `result.json`.

use crate::result::{Acceptance, DeterministicRungs, RunResult};

/// Count completed gardening turns from an observed cursor-name sequence.
///
/// A **turn** is one completed gardening step. The runner polls
/// `orchestrator.gardening_cursor`; each time the committed `step_name` differs
/// from the previously observed one, a step finished — one turn. Consecutive
/// identical observations (the runner polled faster than the step advanced) are
/// collapsed, so the count is the number of cursor *advances*, not the number of
/// polls. The loop repeats its nine-step pass, so the same step name recurs
/// across passes and is correctly counted again on each fresh advance.
///
/// The first observation counts as one turn (the first step committed its
/// cursor). An empty sequence is zero turns.
pub fn count_turns<S: AsRef<str>>(cursor_observations: &[S]) -> u32 {
    let mut turns = 0u32;
    let mut last: Option<&str> = None;
    for obs in cursor_observations {
        let name = obs.as_ref();
        if last != Some(name) {
            turns += 1;
            last = Some(name);
        }
    }
    turns
}

/// Fold the observed cursor sequence and the gating grader verdicts into a
/// [`RunResult`].
///
/// `accepted` is the scenario's accept rule applied to the gating rungs (for
/// `todo-app`: `project_graph AND compiling_candidate`). `turns_to_acceptable`
/// is the turn count at the moment acceptance was first reached — here, the
/// total turns observed when `accepted` is true, or `None` when the budget was
/// exhausted without acceptance.
///
/// The `browser_smoke` leg is observed, not gating (see the scenario's
/// `acceptance.md`), so it is recorded on the result but excluded from
/// `accepted`.
///
/// The deterministic floor (`deterministic`) and `elapsed_seconds` are folded in
/// by the caller after this returns (the live observer computes them up front and
/// re-stamps the elapsed clock on each flush), so they default here.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_run<S: AsRef<str>>(
    scenario: impl Into<String>,
    workspace_id: impl Into<String>,
    cursor_observations: &[S],
    turn_budget: u32,
    page_revisions: u32,
    acceptance: Acceptance,
    browser_smoke: impl Into<String>,
) -> RunResult {
    let turns_used = count_turns(cursor_observations);
    let accepted = acceptance.accepted();
    RunResult {
        scenario: scenario.into(),
        workspace_id: workspace_id.into(),
        accepted,
        turns_to_acceptable: accepted.then_some(turns_used),
        turns_used,
        turn_budget,
        page_revisions,
        rungs: acceptance,
        deterministic: DeterministicRungs::default(),
        elapsed_seconds: 0,
        browser_smoke: browser_smoke.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sf_loop::STEP_ORDER;

    #[test]
    fn count_turns_collapses_repeated_polls() {
        // Polled the same step three times before it advanced, etc.
        let obs = [
            "strategy_research",
            "strategy_research",
            "prd_reconcile",
            "prd_reconcile",
            "prd_reconcile",
            "technical_research",
        ];
        assert_eq!(count_turns(&obs), 3, "three distinct cursor advances");
    }

    #[test]
    fn count_turns_counts_recurring_steps_across_passes() {
        // The loop wraps: the same step name recurs on the next pass and must be
        // counted again as a fresh advance.
        let obs = [
            "project_graph_derive",
            "code_change_proposal",
            "strategy_research", // pass 2 begins — fresh advance
            "prd_reconcile",
        ];
        assert_eq!(count_turns(&obs), 4);
    }

    #[test]
    fn count_turns_empty_is_zero() {
        let empty: [&str; 0] = [];
        assert_eq!(count_turns(&empty), 0);
    }

    #[test]
    fn count_turns_matches_one_full_pass() {
        let names: Vec<&str> = STEP_ORDER.iter().map(|s| s.name()).collect();
        assert_eq!(
            count_turns(&names),
            STEP_ORDER.len() as u32,
            "one full pass over STEP_ORDER is nine turns"
        );
    }

    #[test]
    fn evaluate_run_unaccepted_has_no_turns_to_acceptable() {
        let obs = ["strategy_research", "prd_reconcile"];
        let result = evaluate_run(
            "todo-app",
            "ws-1",
            &obs,
            60,
            2,
            Acceptance {
                project_graph: false,
                compiling_candidate: false,
            },
            "pass",
        );
        assert!(!result.accepted);
        assert_eq!(result.turns_to_acceptable, None);
        assert_eq!(result.turns_used, 2);
    }
}
