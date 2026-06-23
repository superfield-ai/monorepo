//! Evaluation harness for the autonomous gardening loop (issue #748).
//!
//! This is the Rust grader library + runner binary referenced by
//! [`docs/eval-design.md`](../../../docs/eval-design.md) and the
//! [`evals/`](../../../evals/) tree. It implements the **Tier-2 live runner**
//! and the reusable **graders** the `todo-app` scenario's acceptance bar is
//! composed from.
//!
//! The three concepts the `evals/` tree keeps separate map onto modules here:
//!
//! - **scenario** — data (seed intent + acceptance bar) under `evals/scenarios/`;
//!   no code, only the [`Acceptance`] thresholds the runner is handed.
//! - **runner** ([`runner`]) — the engine that drives a scenario through the
//!   real appliance, counts turns by observing the gardening cursor advance, and
//!   emits [`RunResult`] as `result.json`.
//! - **grader** ([`graders`]) — reusable checks (`project-graph`,
//!   `compiling-candidate`) a scenario's acceptance bar is composed from.
//!
//! Network/DB/CLI driving (seed → serve → poll) is intentionally **not** baked
//! into these pure functions so the turn counter, graders, and `result.json`
//! emission are unit-tested without a live model or database. The orchestration
//! that wires them to a real `superfield serve` is the runner binary's job.

pub mod graders;
pub mod result;
pub mod runner;

pub use graders::{compiling_candidate_pass, project_graph_pass};
pub use result::{Acceptance, RunResult};
pub use runner::{count_turns, evaluate_run};
