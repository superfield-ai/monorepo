//! Reusable graders — the pure verdict core of the checks the `todo-app`
//! acceptance bar is composed from.
//!
//! Each grader answers one yes/no question (see
//! [`evals/graders/`](../../../evals/graders/)). The expensive halves (running an
//! LLM judge, querying the Sharp episode store) live in the runner binary; what
//! lives here is the structural verdict the binary and tests share.

/// Grader: `project-graph` (structural fallback).
///
/// Asks: **does the derived project graph describe the app the seed intent asked
/// for?** This is the coarse keyword fallback used when no LLM judge
/// (`SF_EVAL_JUDGE_CMD`) is configured: the graph markdown must mention a
/// task/todo **and** all of the supplied expected verbs. Deterministic and easy
/// to fool — a first signal, not a gate (see the grader spec).
///
/// `expected_verbs` are matched case-insensitively as substrings. For `todo-app`
/// the runner passes `["add", "list", "complete"]`.
pub fn project_graph_pass(graph_markdown: &str, expected_verbs: &[&str]) -> bool {
    let haystack = graph_markdown.to_ascii_lowercase();
    let mentions_task = haystack.contains("task") || haystack.contains("todo");
    let all_verbs = expected_verbs
        .iter()
        .all(|v| haystack.contains(&v.to_ascii_lowercase()));
    mentions_task && all_verbs
}

/// Grader: `compiling-candidate`.
///
/// Asks: **did the loop produce a code change that compiles?** A candidate is
/// stored only if it passed the `cargo check` gate, recorded as a `merge_result`
/// event in the Sharp episode store. The runner probes both episode models
/// (`episode_events.type` and `episode_typed_artifacts.kind`) and passes the
/// observed count here; the verdict is simply whether at least one exists.
pub fn compiling_candidate_pass(merge_result_count: u64) -> bool {
    merge_result_count >= 1
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODO_VERBS: &[&str] = &["add", "list", "complete"];

    #[test]
    fn project_graph_passes_when_task_and_all_verbs_present() {
        let graph = "# Issue: Task tracker\n- Feature: Add a task\n- Feature: List tasks\n- Feature: Complete a task";
        assert!(project_graph_pass(graph, TODO_VERBS));
    }

    #[test]
    fn project_graph_fails_on_missing_verb() {
        let graph = "# Issue: Task tracker\n- Feature: Add a task\n- Feature: List tasks";
        assert!(
            !project_graph_pass(graph, TODO_VERBS),
            "missing 'complete' must fail"
        );
    }

    #[test]
    fn project_graph_fails_without_task_noun() {
        let graph = "Add, list and complete some widgets";
        assert!(
            !project_graph_pass(graph, TODO_VERBS),
            "no task/todo noun must fail"
        );
    }

    #[test]
    fn project_graph_is_case_insensitive() {
        let graph = "TODO: ADD, LIST, COMPLETE";
        assert!(project_graph_pass(graph, TODO_VERBS));
    }

    #[test]
    fn compiling_candidate_passes_with_a_merge_result() {
        assert!(compiling_candidate_pass(1));
        assert!(compiling_candidate_pass(3));
        assert!(!compiling_candidate_pass(0));
    }
}
