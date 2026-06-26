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

/// The **deterministic** rungs — the ones reached without the live-LLM gardening
/// loop converging.
///
/// These are produced by the offline pipeline the workflow runs *before* the
/// live observer enters its poll loop: the appliance seeds the intent
/// (`superfield garden`), which ingests + embeds it, and a semantic-search probe
/// confirms the governed embedding model can retrieve the seeded content. Because
/// they do not depend on the stochastic, budget-bounded live-LLM turns, the
/// runner can flush a meaningful `result.json` recording them up front — so a
/// budget-exhausted (or wall-killed) run still yields a parseable artifact
/// (issue #780, AC2/AC3).
///
/// They are **not** part of the `accepted` gate (that stays the live
/// [`Acceptance`] rungs); they are the artifact's deterministic floor and, when
/// any of them fails, signal a real broken-resource condition the runner reports
/// loudly (a non-zero exit) rather than papering over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DeterministicRungs {
    /// The `seed` corpus exists for the workspace (the intent was seeded).
    pub seed: bool,
    /// At least one embedded block was ingested into the seed corpus.
    pub ingest: bool,
    /// A semantic-search probe against the governed embedding model retrieved a
    /// seeded block (proves end-to-end embedding coverage).
    pub semantic_search: bool,
}

impl DeterministicRungs {
    /// All deterministic rungs passed — the embedding pipeline is healthy and the
    /// artifact's floor is real.
    pub fn all_pass(self) -> bool {
        self.seed && self.ingest && self.semantic_search
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
    /// Per-rung pass/fail of the live (gating) acceptance bar.
    pub rungs: Acceptance,
    /// Per-rung pass/fail of the deterministic floor (seed/ingest/semantic-search)
    /// — recorded up front so a budget-exhausted live-LLM run still yields a
    /// meaningful artifact (issue #780).
    pub deterministic: DeterministicRungs,
    /// Wall-clock seconds the observer spent before it stopped (acceptance,
    /// budget exhaustion, or the wall-clock deadline).
    pub elapsed_seconds: u64,
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

    #[test]
    fn deterministic_rungs_require_all_three() {
        assert!(DeterministicRungs {
            seed: true,
            ingest: true,
            semantic_search: true
        }
        .all_pass());
        assert!(!DeterministicRungs {
            seed: true,
            ingest: true,
            semantic_search: false
        }
        .all_pass());
        assert!(!DeterministicRungs::default().all_pass());
    }

    #[test]
    fn deterministic_floor_emits_even_when_live_run_unaccepted() {
        // A budget-exhausted live run: gating rungs failed, but the deterministic
        // floor passed — the artifact must still record a meaningful, parseable
        // result (issue #780, AC3).
        let result = RunResult {
            scenario: "todo-app".into(),
            workspace_id: "ws-budget".into(),
            accepted: false,
            turns_to_acceptable: None,
            turns_used: 8,
            turn_budget: 8,
            page_revisions: 3,
            rungs: Acceptance {
                project_graph: false,
                compiling_candidate: false,
            },
            deterministic: DeterministicRungs {
                seed: true,
                ingest: true,
                semantic_search: true,
            },
            elapsed_seconds: 42,
            browser_smoke: "skipped".into(),
        };

        let json = result.to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid json");
        assert_eq!(parsed["accepted"], false);
        assert_eq!(parsed["deterministic"]["seed"], true);
        assert_eq!(parsed["deterministic"]["semantic_search"], true);
        assert_eq!(parsed["elapsed_seconds"], 42);

        let typed: RunResult = serde_json::from_str(&json).expect("round-trips");
        assert!(typed.deterministic.all_pass());
        assert!(!typed.accepted);
    }
}
