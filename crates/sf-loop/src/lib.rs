//! Gardening loop engine — continuous resumable knowledge-base improvement.
//!
//! This crate implements the `GardeningLoop` and a real [`sf_serve::LoopHandle`]
//! that the daemon will store in `AppState` and calls on graceful
//! shutdown.
//!
//! # Architecture
//!
//! The loop runs seven [`GardeningStep`] variants in order, then repeats:
//!
//! 1. `StrategyResearch` — web research on company strategy → "strategy" page revision
//! 2. `PrdReconcile`     — reconcile PRD against research → "prd" page revision
//! 3. `TechnicalResearch`— research technical implementations → "technical" page revision
//! 4. `ArchitectureProposal` — derive architecture from PRD + technical → "architecture" page revision
//! 5. `PlanProposal`     — derive implementation plan from architecture → "plan" page revision
//! 6. `HolisticReconcile`— re-read all five topics, propagate changes
//! 7. `ProjectGraphDerive` — parse the gardened plan into project-graph
//!    Feature/Issue nodes (`insert_issue`/`insert_feature`); does NOT write a
//!    `page_revisions` row
//!
//! Each of steps 1–6 (the page-authoring steps):
//! - Calls [`AgentExecutor::run`] to produce content + provenance.
//! - Writes a `nexum.page_revisions` row via [`sf_db::insert_page_revision`].
//! - Commits the cursor to `orchestrator.gardening_cursor`.
//!
//! The seventh step (`ProjectGraphDerive`) instead derives Feature/Issue nodes
//! from the latest plan revision and commits the cursor as usual.
//!
//! Restarting the daemon after a crash resumes from the last committed cursor.
//!
//! # External-call guard
//!
//! When `SF_OTEL_DISABLED=1` is set, the real [`LlmAgentExecutor`] skips all
//! outbound HTTP calls and returns a canned response.  Tests rely on the
//! [`FixtureAgentExecutor`] which never makes any outbound call.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Daemon Lifecycle
//! - `docs/milestone-1.md` §4.4

pub mod agent;
pub mod blueprint;
pub mod cursor;
pub mod handle;
pub mod steps;

pub use agent::{
    AgentExecutor, AgentRequest, AgentResponse, FixtureAgentExecutor, LlmAgentExecutor,
};
pub use blueprint::BlueprintRules;
pub use cursor::{commit_cursor, load_cursor, CursorError};
pub use handle::GardeningLoopHandle;
pub use steps::{GardeningStep, STEP_ORDER};

use std::sync::Arc;
use tokio::task::JoinHandle;
use uuid::Uuid;

/// Configuration for the gardening loop.
#[derive(Debug, Clone)]
pub struct LoopConfig {
    /// Workspace UUID — used to scope cursor and page-revision rows.
    pub workspace_id: Uuid,
    /// Path to `blueprint/rules/graph.yaml`.
    pub blueprint_path: std::path::PathBuf,
    /// LLM API key (from `SF_LLM_API_KEY` env var).
    pub llm_api_key: String,
    /// LLM endpoint URL (from `SF_LLM_ENDPOINT`).
    pub llm_endpoint: String,
    /// LLM model name (from `SF_LLM_MODEL`; default: `claude-haiku-4-5-20251001`).
    pub llm_model: String,
}

impl LoopConfig {
    /// Build from environment variables.
    ///
    /// # Panics
    ///
    /// Panics if `WORKSPACE_ID` is not a valid UUID.
    pub fn from_env() -> Self {
        let workspace_id: Uuid = std::env::var("WORKSPACE_ID")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(Uuid::new_v4);

        let blueprint_path = std::env::var("BLUEPRINT_PATH")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("blueprint/rules/graph.yaml"));

        let llm_api_key = std::env::var("SF_LLM_API_KEY").unwrap_or_default();
        let llm_endpoint = std::env::var("SF_LLM_ENDPOINT")
            .unwrap_or_else(|_| "https://api.anthropic.com/v1/messages".to_string());
        let llm_model = std::env::var("SF_LLM_MODEL")
            .unwrap_or_else(|_| "claude-haiku-4-5-20251001".to_string());

        Self {
            workspace_id,
            blueprint_path,
            llm_api_key,
            llm_endpoint,
            llm_model,
        }
    }
}

/// The gardening loop engine.
///
/// Call [`GardeningLoop::start`] to spawn the background task and get back a
/// [`GardeningLoopHandle`] that the daemon holds until shutdown.
pub struct GardeningLoop;

impl GardeningLoop {
    /// Spawn the gardening loop in a background Tokio task.
    ///
    /// Returns a [`GardeningLoopHandle`] the daemon uses for drain/abort.
    pub fn start(
        pool: sqlx::PgPool,
        config: LoopConfig,
        executor: Arc<dyn AgentExecutor>,
    ) -> GardeningLoopHandle {
        Self::start_observed(pool, config, executor, None)
    }

    /// Spawn the gardening loop with an optional observable-state sink.
    ///
    /// When `observer` is `Some`, each gardening step records a tick — duration
    /// and `lastTickAt` — on the `dev` lane of the orchestrator state and
    /// publishes a log line to the `/orchestrator/logs` stream, so the
    /// control-panel Orchestrator tab shows real loop health and live logs
    /// (issue #674).
    pub fn start_observed(
        pool: sqlx::PgPool,
        config: LoopConfig,
        executor: Arc<dyn AgentExecutor>,
        observer: Option<sf_serve::OrchestratorState>,
    ) -> GardeningLoopHandle {
        // Channels for drain signalling.
        let (drain_tx, drain_rx) = tokio::sync::oneshot::channel::<()>();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();

        let join: JoinHandle<()> = tokio::spawn(async move {
            run_loop(pool, config, executor, observer, drain_rx, done_tx).await;
        });

        GardeningLoopHandle::new(drain_tx, done_rx, join)
    }
}

/// Inner loop: resume from cursor, advance steps, repeat.
async fn run_loop(
    pool: sqlx::PgPool,
    config: LoopConfig,
    executor: Arc<dyn AgentExecutor>,
    observer: Option<sf_serve::OrchestratorState>,
    mut drain_rx: tokio::sync::oneshot::Receiver<()>,
    done_tx: tokio::sync::oneshot::Sender<()>,
) {
    let blueprint = match BlueprintRules::load(&config.blueprint_path) {
        Ok(b) => Arc::new(b),
        Err(e) => {
            tracing::warn!("BlueprintRules::load failed ({}); using empty rules", e);
            Arc::new(BlueprintRules::empty())
        }
    };

    'outer: loop {
        // Check for drain signal before starting a new pass.
        if drain_rx.try_recv().is_ok() {
            break 'outer;
        }

        // Load the last committed cursor step.
        let last_step = match load_cursor(&pool, config.workspace_id).await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("load_cursor failed: {}", e);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue 'outer;
            }
        };

        // Find the index to resume from.
        let start_idx = match last_step {
            None => 0,
            Some(ref name) => {
                STEP_ORDER
                    .iter()
                    .position(|s| s.name() == name.as_str())
                    .map(|i| i + 1) // resume AFTER the last committed step
                    .unwrap_or(0)
            }
        };

        for (idx, step) in STEP_ORDER.iter().enumerate() {
            if idx < start_idx {
                continue;
            }

            // Check drain before each step.
            if drain_rx.try_recv().is_ok() {
                break 'outer;
            }

            tracing::info!("gardening: running step {:?}", step.name());
            if let Some(obs) = observer.as_ref() {
                obs.publish_log(format!("gardening: running step {}", step.name()));
            }

            let tick_start = std::time::Instant::now();
            let result = steps::run_step(
                step,
                &pool,
                config.workspace_id,
                executor.as_ref(),
                blueprint.as_ref(),
            )
            .await;
            let tick_ms = tick_start.elapsed().as_millis() as i64;

            match result {
                Ok(()) => {
                    if let Some(obs) = observer.as_ref() {
                        obs.record_dev_tick(tick_ms);
                        obs.publish_log(format!(
                            "gardening: step {} ok ({} ms)",
                            step.name(),
                            tick_ms
                        ));
                    }
                    if let Err(e) = commit_cursor(&pool, config.workspace_id, step.name()).await {
                        tracing::error!("commit_cursor failed for {}: {}", step.name(), e);
                    }
                }
                Err(e) => {
                    tracing::error!("step {} failed: {}", step.name(), e);
                    if let Some(obs) = observer.as_ref() {
                        obs.record_dev_failure();
                        obs.publish_log(format!("gardening: step {} failed: {}", step.name(), e));
                    }
                    // On failure, pause briefly and retry the pass from the cursor.
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    continue 'outer;
                }
            }
        }

        // Full pass complete — small delay before the next pass.
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {}
            _ = &mut drain_rx => { break 'outer; }
        }
    }

    // Signal that the loop has fully stopped.
    let _ = done_tx.send(());
}
