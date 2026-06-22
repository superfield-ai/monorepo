//! Gardening step definitions and dispatcher.
//!
//! [`GardeningStep`] enumerates the nine knowledge-base improvement steps.
//! [`STEP_ORDER`] defines the canonical execution order.
//! [`run_step`] dispatches to the appropriate implementation module.
//!
//! # Step implementations
//!
//! Each step module follows this contract:
//! 1. Reads any relevant page content from the DB (via `sf_db::fetch_page_content`).
//! 2. Builds an [`AgentRequest`] and calls `executor.run(req)`.
//! 3. Calls `sf_db::insert_page_revision` with the result.
//!
//! The cursor commit happens AFTER `run_step` returns Ok, in the main loop
//! (`crate::run_loop`).
//!
//! # Acceptance criteria mapping
//!
//! | Criterion                                  | Step                    |
//! |--------------------------------------------|-------------------------|
//! | `strategy_step_writes_page_revision_*`     | `StrategyResearch`      |
//! | `architecture_step_consults_blueprint_*`   | `ArchitectureProposal`  |
//! | `holistic_reconcile_propagates_change`     | `HolisticReconcile`     |

mod architecture_proposal;
mod code_change_proposal;
mod holistic_reconcile;
mod intent_spec_inference;
mod plan_proposal;
mod prd_reconcile;
mod project_graph_derive;
mod strategy_research;
mod technical_research;

use crate::agent::AgentExecutor;
use crate::blueprint::BlueprintRules;
use thiserror::Error;
use uuid::Uuid;

/// Error type for gardening step failures.
#[derive(Debug, Error)]
pub enum StepError {
    /// Agent executor error.
    #[error("agent error: {0}")]
    Agent(#[from] crate::agent::AgentError),
    /// Database write error.
    #[error("db error: {0}")]
    Db(#[from] sf_db::PageRevisionError),
    /// Page read error.
    #[error("page query error: {0}")]
    PageQuery(#[from] sf_db::PageQueryError),
    /// Project-graph write error (Feature/Issue node derivation).
    #[error("project graph error: {0}")]
    ProjectGraph(#[from] sf_db::ProjectGraphError),
    /// Sharp semantic-merge / episode error (code-change proposal gate).
    ///
    /// Note: [`sharp::SharpError::MergeRefused`] is intentionally NOT surfaced
    /// here — the code-change step swallows a refused (non-compiling) proposal
    /// so the loop cursor still advances. Only infrastructure-level Sharp
    /// failures reach this variant.
    #[error("sharp error: {0}")]
    Sharp(#[from] sharp::SharpError),
    /// Runtime-signal read error (intent-to-spec inference).
    #[error("runtime signal error: {0}")]
    RuntimeSignal(#[from] sf_db::RuntimeSignalError),
}

/// The observable result of running a single gardening step.
///
/// Carries the cost the step's agent call(s) reported so the loop can publish
/// it onto the active [`WorkSlot`](sf_serve::WorkSlot) and accumulate it across
/// a pass — the cost producer the Orchestrator slot cards read (issue #712).
#[derive(Debug, Clone, Copy, Default)]
pub struct StepOutcome {
    /// US-dollar cost the step's executor call(s) reported.
    pub cost_usd: f64,
}

/// The lane the control-panel Orchestrator tab buckets a step under.
///
/// The loop reports per-lane health so the tab shows live `plan` and `doc`
/// health, not only `dev` (issue #712 — the plan/doc lanes were previously
/// inert and always reported default health).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopLane {
    /// Planning lane (PRD / architecture / plan authoring + graph derivation).
    Plan,
    /// Development lane (the gardening pass as a whole / project-graph nodes).
    Dev,
    /// Documentation lane (strategy / technical / holistic reconciliation).
    Doc,
}

/// The nine gardening steps, in execution order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GardeningStep {
    /// Research company strategy from seed documents.
    StrategyResearch,
    /// Reconcile the PRD against strategy research.
    PrdReconcile,
    /// Research technical implementation options.
    TechnicalResearch,
    /// Propose architecture from PRD + technical research + Blueprint rules.
    ArchitectureProposal,
    /// Propose implementation plan from architecture.
    PlanProposal,
    /// Infer a proposed spec delta from runtime signals (#709, PRD US6).
    IntentSpecInference,
    /// Holistically reconcile all five pages for consistency.
    HolisticReconcile,
    /// Derive Feature/Issue project-graph nodes from brain knowledge (#672).
    ProjectGraphDerive,
    /// Propose a validated source change for an open node through the Sharp
    /// semantic-merge + cargo check gate (#706).
    CodeChangeProposal,
}

impl GardeningStep {
    /// Canonical step name — used as the cursor `step_name` value.
    pub fn name(&self) -> &'static str {
        match self {
            Self::StrategyResearch => "strategy_research",
            Self::PrdReconcile => "prd_reconcile",
            Self::TechnicalResearch => "technical_research",
            Self::ArchitectureProposal => "architecture_proposal",
            Self::PlanProposal => "plan_proposal",
            Self::IntentSpecInference => "intent_spec_inference",
            Self::HolisticReconcile => "holistic_reconcile",
            Self::ProjectGraphDerive => "project_graph_derive",
            Self::CodeChangeProposal => "code_change_proposal",
        }
    }

    /// The control-panel loop lane this step's health is reported under.
    ///
    /// Mapping (issue #712 — populate the previously-inert `plan` and `doc`
    /// lanes from real step activity):
    /// - **Doc**: `strategy_research`, `technical_research`, `holistic_reconcile`
    ///   — the knowledge-page authoring/reconciliation steps.
    /// - **Plan**: `prd_reconcile`, `architecture_proposal`, `plan_proposal`,
    ///   `intent_spec_inference` — the steps that shape the PRD/architecture/plan
    ///   documents (intent-to-spec inference proposes a spec delta to them, #709).
    /// - **Dev**: `project_graph_derive` — derives the Feature/Issue work graph;
    ///   `code_change_proposal` — proposes a validated source change for an open
    ///   node through the Sharp semantic-merge gate (#706).
    pub fn lane(&self) -> LoopLane {
        match self {
            Self::StrategyResearch | Self::TechnicalResearch | Self::HolisticReconcile => {
                LoopLane::Doc
            }
            Self::PrdReconcile
            | Self::ArchitectureProposal
            | Self::PlanProposal
            | Self::IntentSpecInference => LoopLane::Plan,
            Self::ProjectGraphDerive | Self::CodeChangeProposal => LoopLane::Dev,
        }
    }
}

/// Canonical step execution order.
///
/// # Insertion point for the knowledge-derivation step (dev-scout, issue #677)
///
/// The knowledge-to-work feature (#672) adds a step that derives Feature/Issue
/// project-graph nodes from brain knowledge and writes them through
/// `sf_db::project_graph` (`insert_feature` / `insert_issue`) — not via the
/// document-page write path the existing six steps use.
///
/// To add it without disturbing the existing loop:
/// 1. Add a `GardeningStep` variant (e.g. `ProjectDerivation`) plus its
///    [`GardeningStep::name`] arm.
/// 2. Add a `mod project_derivation;` module whose `run(...)` reads page
///    content and writes via `sf_db::project_graph` instead of
///    `sf_db::insert_page_revision`.
/// 3. Add a [`run_step`] match arm dispatching to it.
/// 4. Append the variant to this `STEP_ORDER` slice — **after**
///    `PlanProposal` and **before** `HolisticReconcile` so the holistic pass
///    still runs last over the now-richer graph.
///
/// The cursor/resume machinery in `crate::run_loop` keys off
/// [`GardeningStep::name`] and `STEP_ORDER` positions, so a new entry is
/// resumable automatically with no loop-engine change. This dev-scout pass
/// documents the insertion contract only; it adds no new step.
pub const STEP_ORDER: &[GardeningStep] = &[
    GardeningStep::StrategyResearch,
    GardeningStep::PrdReconcile,
    GardeningStep::TechnicalResearch,
    GardeningStep::ArchitectureProposal,
    GardeningStep::PlanProposal,
    // Intent-to-spec inference (#709) reads runtime signals and proposes a spec
    // delta. Placed before HolisticReconcile so the holistic pass runs last over
    // the now-richer state, matching the documented insertion contract above.
    GardeningStep::IntentSpecInference,
    GardeningStep::HolisticReconcile,
    GardeningStep::ProjectGraphDerive,
    // #706 code-change step runs last: it proposes a validated source change
    // for an open node in the now-gardened project graph.
    GardeningStep::CodeChangeProposal,
];

/// Dispatch a single gardening step.
///
/// Reads current page state, calls the executor, and writes the page revision.
/// The cursor commit is the caller's responsibility (done in `run_loop`).
pub async fn run_step(
    step: &GardeningStep,
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
    executor: &dyn AgentExecutor,
    blueprint: &BlueprintRules,
) -> Result<StepOutcome, StepError> {
    match step {
        GardeningStep::StrategyResearch => {
            strategy_research::run(pool, workspace_id, executor).await
        }
        GardeningStep::PrdReconcile => prd_reconcile::run(pool, workspace_id, executor).await,
        GardeningStep::TechnicalResearch => {
            technical_research::run(pool, workspace_id, executor).await
        }
        GardeningStep::ArchitectureProposal => {
            architecture_proposal::run(pool, workspace_id, executor, blueprint).await
        }
        GardeningStep::PlanProposal => plan_proposal::run(pool, workspace_id, executor).await,
        GardeningStep::IntentSpecInference => {
            intent_spec_inference::run(pool, workspace_id, executor).await
        }
        GardeningStep::HolisticReconcile => {
            holistic_reconcile::run(pool, workspace_id, executor).await
        }
        GardeningStep::ProjectGraphDerive => {
            project_graph_derive::run(pool, workspace_id, executor).await
        }
        GardeningStep::CodeChangeProposal => {
            code_change_proposal::run(pool, workspace_id, executor).await
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_names_are_unique() {
        let names: Vec<&str> = STEP_ORDER.iter().map(|s| s.name()).collect();
        let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
        assert_eq!(names.len(), unique.len(), "step names must be unique");
    }

    #[test]
    fn step_order_has_nine_entries() {
        assert_eq!(STEP_ORDER.len(), 9);
    }

    #[test]
    fn code_change_proposal_runs_last() {
        assert_eq!(
            STEP_ORDER.last().copied(),
            Some(GardeningStep::CodeChangeProposal),
            "the code-change proposal step must run last, over the gardened graph",
        );
    }

    #[test]
    fn intent_spec_inference_runs_before_holistic_reconcile() {
        let pos = |s: GardeningStep| STEP_ORDER.iter().position(|x| *x == s).unwrap();
        assert!(
            pos(GardeningStep::IntentSpecInference) < pos(GardeningStep::HolisticReconcile),
            "intent_spec_inference must precede holistic_reconcile"
        );
    }

    #[test]
    fn step_name_round_trips() {
        for step in STEP_ORDER {
            let name = step.name();
            assert!(!name.is_empty());
            assert!(!name.contains(' '));
        }
    }
}
