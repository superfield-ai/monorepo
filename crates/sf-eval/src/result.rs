//! `result.json` shape and emission.
//!
//! The live runner writes one [`RunResult`] per run under
//! `evals/results/<scenario>/<workspace-id>/result.json`. The shape matches the
//! spec in [`evals/runners/live.md`](../../../evals/runners/live.md): a headline
//! `turns_to_acceptable` plus per-rung pass/fail.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The gating rungs of the `todo-app` acceptance bar.
///
/// `accepted = project_graph AND compiling_candidate`. The browser smoke is
/// observed but not part of the gate today (see the scenario's `acceptance.md`),
/// so it lives on [`RunResult`] rather than here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Acceptance {
    /// Rung 1: the project graph describes add/list/complete.
    pub project_graph: bool,
    /// Rung 2: a compiling `CodeChangeProposal` candidate exists.
    pub compiling_candidate: bool,
}

impl Acceptance {
    /// The scenario accept rule: all gating rungs must pass.
    pub fn accepted(self) -> bool {
        self.project_graph && self.compiling_candidate
    }
}

/// One run's outcome — serialized to `result.json`.
///
/// Field set mirrors [`evals/runners/live.md`](../../../evals/runners/live.md):
/// the headline `turns_to_acceptable`, the per-rung verdicts, and the run knobs
/// (`turn_budget`, `page_revisions`) needed to interpret the headline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunResult {
    /// Scenario name, e.g. `todo-app`.
    pub scenario: String,
    /// Workspace UUID the run drove.
    pub workspace_id: String,
    /// Whether the gating acceptance bar was met.
    pub accepted: bool,
    /// Turns observed when acceptance was first reached; `None` if never accepted.
    pub turns_to_acceptable: Option<u32>,
    /// Total turns observed before the run stopped (accepted or budget-exhausted).
    pub turns_used: u32,
    /// The turn budget the run was given.
    pub turn_budget: u32,
    /// `nexum.page_revisions` row count, corroborating the turn count.
    pub page_revisions: u32,
    /// Per-rung pass/fail.
    pub rungs: Acceptance,
    /// Browser-smoke verdict (`pass` / `fail` / `skipped`) — observed, not gating.
    pub browser_smoke: String,
}

impl RunResult {
    /// The canonical relative path a run's `result.json` is written under:
    /// `results/<scenario>/<workspace-id>/result.json`.
    pub fn result_path(results_root: &Path, scenario: &str, workspace_id: &str) -> PathBuf {
        results_root
            .join(scenario)
            .join(workspace_id)
            .join("result.json")
    }

    /// Serialize to pretty JSON.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("RunResult serializes")
    }

    /// Write `result.json` under `results_root/<scenario>/<workspace-id>/`,
    /// creating parent directories. Returns the path written.
    pub fn write_under(&self, results_root: &Path) -> std::io::Result<PathBuf> {
        let path = Self::result_path(results_root, &self.scenario, &self.workspace_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, self.to_json())?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acceptance_requires_both_rungs() {
        assert!(Acceptance {
            project_graph: true,
            compiling_candidate: true
        }
        .accepted());
        assert!(!Acceptance {
            project_graph: true,
            compiling_candidate: false
        }
        .accepted());
        assert!(!Acceptance {
            project_graph: false,
            compiling_candidate: true
        }
        .accepted());
    }

    #[test]
    fn result_path_is_scenario_workspace_scoped() {
        let p = RunResult::result_path(Path::new("evals/results"), "todo-app", "ws-9");
        assert!(p.ends_with("todo-app/ws-9/result.json"));
    }
}
