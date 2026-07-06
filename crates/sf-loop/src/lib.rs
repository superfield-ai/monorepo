//! Gardening loop engine — continuous resumable knowledge-base improvement.
//!
//! This crate implements the `GardeningLoop` and a real [`sf_serve::LoopHandle`]
//! that the daemon will store in `AppState` and calls on graceful
//! shutdown.
//!
//! # Architecture
//!
//! The loop runs nine [`GardeningStep`] variants in order, then repeats:
//!
//! 1. `StrategyResearch` — web research on company strategy → "strategy" page revision
//! 2. `PrdReconcile`     — reconcile PRD against research → "prd" page revision
//! 3. `TechnicalResearch`— research technical implementations → "technical" page revision
//! 4. `ArchitectureProposal` — derive architecture from PRD + technical → "architecture" page revision
//! 5. `PlanProposal`     — derive implementation plan from architecture → "plan" page revision
//! 6. `IntentSpecInference` — read `sharp.runtime_signals`, compare actual usage
//!    to stated intent, and propose a spec delta → "spec-delta-proposal" page
//!    revision. No-ops (writes nothing) when there are no signals. The proposal
//!    is never auto-applied; a human confirms or corrects it (#709, PRD US6).
//! 7. `HolisticReconcile`— re-read all five topics, propagate changes
//! 8. `ProjectGraphDerive` — parse the gardened plan into project-graph
//!    Feature/Issue nodes (`insert_issue`/`insert_feature`); does NOT write a
//!    `page_revisions` row
//! 9. `CodeChangeProposal` — select an open node, ask the agent for a source
//!    diff, and gate it through the Sharp semantic-merge + `cargo check` gate
//!    (`sharp::merge_flow::run_merge_flow`); a non-compiling proposal is refused
//!    (`SharpError::MergeRefused`) and discarded, never stored (#706). Once a
//!    proposal for a `Feature` node merges, [`acceptance::execute_criteria_for_feature_change`]
//!    executes that Feature's attached acceptance criteria and records one
//!    verdict per criterion in `forge.validation_runs` (#861) — see the
//!    [`acceptance`] module doc comment for the http-probe/playwright
//!    scoping decisions and the assertion-schema (#860) gap it documents.
//!
//! Each of the page-authoring steps:
//! - Calls [`AgentExecutor::run`] to produce content + provenance.
//! - Writes a `nexum.page_revisions` row via [`sf_db::insert_page_revision`].
//! - Commits the cursor to `orchestrator.gardening_cursor`.
//!
//! `IntentSpecInference` writes a `spec-delta-proposal` page revision only when
//! runtime signals are present; otherwise it no-ops and the cursor still
//! advances. `ProjectGraphDerive` instead derives Feature/Issue nodes from the
//! latest plan revision; `CodeChangeProposal` emits a validated code-change
//! candidate through Sharp. All commit the cursor as usual.
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

pub mod acceptance;
pub mod agent;
pub mod blueprint;
pub mod cursor;
pub mod handle;
pub mod provider;
pub mod steps;

pub use acceptance::{
    execute_and_record, execute_criteria_for_feature_change, resolve_attached_criteria,
    AcceptanceError, AttachedCriterion, CriterionVerdict, ExecutionContext,
};
pub use agent::{
    AgentExecutor, AgentRequest, AgentResponse, FixtureAgentExecutor, LlmAgentExecutor,
};
pub use blueprint::BlueprintRules;
pub use cursor::{commit_cursor, load_cursor, CursorError};
pub use handle::GardeningLoopHandle;
pub use provider::LlmProvider;
pub use steps::{GardeningStep, LoopLane, StepOutcome, STEP_ORDER};

use std::sync::Arc;
use tokio::task::JoinHandle;
use uuid::Uuid;

/// First-run LLM credential state, derived from the configured API key.
///
/// On a fresh appliance no `SF_LLM_API_KEY` is set, so the loop (and the studio
/// agent) would silently run against the deterministic [`FixtureAgentExecutor`]
/// — gardening placeholder content and answering canned echoes. Modelling the
/// credential as an explicit state lets the daemon surface an
/// [`LlmCredentialState::Unconfigured`] banner at boot/status rather than
/// silently degrading, and lets tests assert which executor the appliance
/// selects (issue #714).
///
/// Fixtures remain the intended path for CI/tests, which never set the key (or
/// set `SF_OTEL_DISABLED=1`); they are NOT the intended first-run production
/// path, which requires the operator to supply a credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmCredentialState {
    /// A non-empty `SF_LLM_API_KEY` is present: the real [`LlmAgentExecutor`] is
    /// selected and the appliance does real LLM work.
    Configured,
    /// No `SF_LLM_API_KEY` is set: the appliance is unconfigured and falls back
    /// to the [`FixtureAgentExecutor`]. The daemon must surface this explicitly.
    Unconfigured,
}

impl LlmCredentialState {
    /// Derive the credential state from an API key value.
    ///
    /// A whitespace-only or empty key is treated as [`Unconfigured`].
    ///
    /// [`Unconfigured`]: LlmCredentialState::Unconfigured
    pub fn from_key(api_key: &str) -> Self {
        if api_key.trim().is_empty() {
            LlmCredentialState::Unconfigured
        } else {
            LlmCredentialState::Configured
        }
    }

    /// True when no usable credential is configured.
    pub fn is_unconfigured(self) -> bool {
        matches!(self, LlmCredentialState::Unconfigured)
    }

    /// A stable lowercase tag for status payloads and structured logs.
    ///
    /// This NEVER contains the key value — only the configured/unconfigured
    /// state — so it is safe to log and persist (issue #714 acceptance: no key
    /// is logged or persisted).
    pub fn as_str(self) -> &'static str {
        match self {
            LlmCredentialState::Configured => "configured",
            LlmCredentialState::Unconfigured => "unconfigured",
        }
    }

    /// Operator-facing message describing the state.
    ///
    /// Safe to log/print: contains no secret material.
    pub fn boot_message(self) -> &'static str {
        match self {
            LlmCredentialState::Configured => {
                "LLM credential configured: gardening loop and studio agent use the real LLM."
            }
            LlmCredentialState::Unconfigured => {
                "LLM credential unconfigured (SF_LLM_API_KEY is empty): the gardening loop and \
                 studio agent run fixtures only. Set SF_LLM_API_KEY for the appliance to do real \
                 work — see docs/architecture.md \u{a7}First-run LLM credential."
            }
        }
    }
}

/// Configuration for the gardening loop.
#[derive(Debug, Clone)]
pub struct LoopConfig {
    /// Workspace UUID — used to scope cursor and page-revision rows.
    pub workspace_id: Uuid,
    /// Path to `blueprint/rules/graph.yaml`.
    pub blueprint_path: std::path::PathBuf,
    /// LLM wire provider (from `SF_LLM_PROVIDER`; default: `anthropic`).
    pub llm_provider: LlmProvider,
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

        let llm_provider = LlmProvider::from_env();
        // Each provider has its own default endpoint + model, so the default
        // tracks the selected provider unless explicitly overridden. For the
        // keyless OpenCode server provider the "endpoint" is the local
        // `opencode serve` base URL (from `SF_OPENCODE_SERVER`), not an LLM URL.
        let (default_endpoint, default_model) = match llm_provider {
            LlmProvider::Anthropic => (
                "https://api.anthropic.com/v1/messages".to_string(),
                "claude-haiku-4-5-20251001",
            ),
            LlmProvider::OpenAiCompatible => (
                "https://opencode.ai/zen/v1/chat/completions".to_string(),
                "opencode/big-pickle",
            ),
            LlmProvider::OpenCodeServer => (
                std::env::var("SF_OPENCODE_SERVER")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| LlmProvider::DEFAULT_OPENCODE_SERVER.to_string()),
                "opencode/big-pickle",
            ),
        };

        let llm_api_key = std::env::var("SF_LLM_API_KEY")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_default();
        let llm_endpoint = std::env::var("SF_LLM_ENDPOINT")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or(default_endpoint);
        let llm_model = std::env::var("SF_LLM_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default_model.to_string());

        Self {
            workspace_id,
            blueprint_path,
            llm_provider,
            llm_api_key,
            llm_endpoint,
            llm_model,
        }
    }

    /// The first-run LLM credential state.
    ///
    /// [`LlmCredentialState::Configured`] selects the real [`LlmAgentExecutor`];
    /// [`LlmCredentialState::Unconfigured`] selects the fixture fallback and is
    /// what the daemon surfaces explicitly at boot (issue #714).
    ///
    /// A **keyless** provider (the OpenCode server path — issue #748) is always
    /// [`LlmCredentialState::Configured`]: the local `opencode serve` is the credential,
    /// so the appliance does real work with no `SF_LLM_API_KEY` set. HTTP
    /// providers still require a non-empty key.
    pub fn credential_state(&self) -> LlmCredentialState {
        if self.llm_provider.is_keyless() {
            LlmCredentialState::Configured
        } else {
            LlmCredentialState::from_key(&self.llm_api_key)
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

    // Accumulated US-dollar cost across the whole loop lifetime, surfaced on the
    // published work slot so the Orchestrator cards show real, growing spend
    // (PRD US10 / issue #712).
    let mut accumulated_cost_usd: f64 = 0.0;

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
            let lane = lane_to_serve(step.lane());
            let started = chrono::Utc::now();
            if let Some(obs) = observer.as_ref() {
                obs.publish_log(format!("gardening: running step {}", step.name()));
                // Publish a real in-flight work slot for the running step so the
                // Orchestrator cards show live work and accumulated cost rather
                // than an empty list (issue #712).
                obs.set_slots(vec![sf_serve::WorkSlot {
                    slot: idx as u32,
                    issue_number: config.workspace_id.as_u128() as i64 & 0x7fff,
                    role: lane_label(step.lane()).to_string(),
                    session_id: format!("gardening-{}", step.name()),
                    backend: "gardening-loop".to_string(),
                    model: config.llm_model.clone(),
                    started_at: started.to_rfc3339(),
                    elapsed_ms: 0,
                    heartbeat_at: Some(started.timestamp_millis()),
                    cost_usd: accumulated_cost_usd,
                }]);
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
                Ok(outcome) => {
                    accumulated_cost_usd += outcome.cost_usd;
                    if let Some(obs) = observer.as_ref() {
                        obs.record_tick(lane, tick_ms);
                        // Refresh the slot with the elapsed time and the now-grown
                        // accumulated cost.
                        obs.set_slots(vec![sf_serve::WorkSlot {
                            slot: idx as u32,
                            issue_number: config.workspace_id.as_u128() as i64 & 0x7fff,
                            role: lane_label(step.lane()).to_string(),
                            session_id: format!("gardening-{}", step.name()),
                            backend: "gardening-loop".to_string(),
                            model: config.llm_model.clone(),
                            started_at: started.to_rfc3339(),
                            elapsed_ms: tick_ms,
                            heartbeat_at: Some(chrono::Utc::now().timestamp_millis()),
                            cost_usd: accumulated_cost_usd,
                        }]);
                        // Emit a real check-run event on the CI stream so the
                        // Orchestrator CI feed has a producer (issue #712).
                        obs.publish_ci_event(
                            serde_json::json!({
                                "step": step.name(),
                                "lane": lane_label(step.lane()),
                                "status": "completed",
                                "conclusion": "success",
                                "durationMs": tick_ms,
                                "costUsd": outcome.cost_usd,
                                "completedAt": chrono::Utc::now().to_rfc3339(),
                            })
                            .to_string(),
                        );
                        obs.publish_log(format!(
                            "gardening: step {} ok ({} ms, ${:.4})",
                            step.name(),
                            tick_ms,
                            outcome.cost_usd
                        ));
                    }
                    if let Err(e) = commit_cursor(&pool, config.workspace_id, step.name()).await {
                        tracing::error!("commit_cursor failed for {}: {}", step.name(), e);
                    }
                }
                Err(e) => {
                    tracing::error!("step {} failed: {}", step.name(), e);
                    if let Some(obs) = observer.as_ref() {
                        obs.record_failure(lane);
                        obs.publish_ci_event(
                            serde_json::json!({
                                "step": step.name(),
                                "lane": lane_label(step.lane()),
                                "status": "completed",
                                "conclusion": "failure",
                                "durationMs": tick_ms,
                                "completedAt": chrono::Utc::now().to_rfc3339(),
                            })
                            .to_string(),
                        );
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

/// Map a [`LoopLane`] to the matching [`sf_serve::Lane`] the orchestrator state
/// records health against.
fn lane_to_serve(lane: LoopLane) -> sf_serve::Lane {
    match lane {
        LoopLane::Plan => sf_serve::Lane::Plan,
        LoopLane::Dev => sf_serve::Lane::Dev,
        LoopLane::Doc => sf_serve::Lane::Doc,
    }
}

/// Human-readable lane label used on the published work slot and CI events.
fn lane_label(lane: LoopLane) -> &'static str {
    match lane {
        LoopLane::Plan => "plan",
        LoopLane::Dev => "dev",
        LoopLane::Doc => "doc",
    }
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    #[test]
    fn empty_or_blank_key_is_unconfigured() {
        assert_eq!(
            LlmCredentialState::from_key(""),
            LlmCredentialState::Unconfigured
        );
        assert_eq!(
            LlmCredentialState::from_key("   \t\n"),
            LlmCredentialState::Unconfigured
        );
        assert!(LlmCredentialState::from_key("").is_unconfigured());
    }

    #[test]
    fn non_empty_key_is_configured() {
        let state = LlmCredentialState::from_key("sk-ant-abc123");
        assert_eq!(state, LlmCredentialState::Configured);
        assert!(!state.is_unconfigured());
    }

    #[test]
    fn config_credential_state_matches_key() {
        let mut cfg = LoopConfig {
            workspace_id: Uuid::nil(),
            blueprint_path: std::path::PathBuf::from("x.yaml"),
            llm_provider: LlmProvider::Anthropic,
            llm_api_key: String::new(),
            llm_endpoint: "e".into(),
            llm_model: "m".into(),
        };
        assert_eq!(cfg.credential_state(), LlmCredentialState::Unconfigured);
        cfg.llm_api_key = "sk-real".into();
        assert_eq!(cfg.credential_state(), LlmCredentialState::Configured);
    }

    /// The state's loggable surfaces never echo a key value.
    #[test]
    fn surfaces_contain_no_secret() {
        let key = "sk-ant-SECRET-xyz";
        let state = LlmCredentialState::from_key(key);
        assert!(!state.as_str().contains(key));
        assert!(!state.boot_message().contains(key));
        assert_eq!(state.as_str(), "configured");
        assert!(LlmCredentialState::Unconfigured
            .boot_message()
            .contains("SF_LLM_API_KEY"));
    }
}
