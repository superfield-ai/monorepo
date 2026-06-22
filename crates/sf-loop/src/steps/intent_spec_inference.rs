//! Step: IntentSpecInference — infer a spec delta from runtime signals (#709).
//!
//! This is the loop side of PRD US6: *a Steerer states intent and an agent
//! infers the spec from how the software is actually used*. Every other
//! gardening step reads only prior `page_revisions` plus the Blueprint; none
//! read runtime signals. This step closes that gap.
//!
//! # Contract
//!
//! 1. Read the most recent `sharp.runtime_signals` rows via
//!    [`sf_db::fetch_recent_runtime_signals`] (the read seam that lets the loop
//!    consume behavioral traces without depending on the `sharp` crate).
//! 2. **No-op path** — when there are no signals, the step returns `Ok(())`
//!    without calling the agent or writing anything. The loop then commits the
//!    cursor as usual, so the loop advances cleanly on a quiet substrate.
//! 3. **Inference path** — when signals exist, read the current `prd` and
//!    `plan` pages (the stated intent), build an [`AgentRequest`] that asks the
//!    agent to compare *actual usage* against *stated goals*, and write the
//!    result as a `spec-delta-proposal` page revision.
//!
//! # Proposal, never auto-apply (out of scope per #709)
//!
//! The artifact is written to the dedicated `spec-delta-proposal` page — it is
//! **not** merged into the real `prd` / `plan` / `architecture` pages. A human
//! reviews the proposal and confirms or corrects it. The provenance metadata
//! records `"proposal": true` and `"requires_human_confirmation": true` so no
//! downstream consumer mistakes it for an applied spec change.
//!
//! # Canonical docs
//!
//! - `docs/prd.md` US6 — intent-to-spec inference.
//! - `docs/architecture.md` §Daemon Lifecycle — runtime-signal ingestion.

use crate::agent::{AgentExecutor, AgentRequest};
use crate::steps::{StepError, StepOutcome};
use sf_db::{insert_page_revision, RuntimeSignalSummary};
use uuid::Uuid;

/// Page name the proposed spec delta is written to.
pub(crate) const SPEC_DELTA_PAGE: &str = "spec-delta-proposal";

/// How many recent runtime signals to consider in one inference pass.
const SIGNAL_LIMIT: i64 = 50;

/// Render a compact, recency-ordered summary of runtime signals for the prompt.
///
/// One line per signal: `- [kind] source: message`. Pure function so the
/// prompt-construction logic is unit-testable without a database.
pub(crate) fn render_signals(signals: &[RuntimeSignalSummary]) -> String {
    let mut out = String::new();
    for s in signals {
        out.push_str(&format!(
            "- [{}] {}: {}\n",
            s.signal_kind, s.source, s.message
        ));
    }
    out
}

/// Build the agent request comparing actual usage (signals) to stated intent.
///
/// Pure function: given the rendered signal summary and the current `prd` /
/// `plan` page content, produce the [`AgentRequest`]. Tested directly without
/// touching the executor or the database.
pub(crate) fn build_request(signals_md: &str, prd: &str, plan: &str) -> AgentRequest {
    let system = "You are a product analyst comparing how software is ACTUALLY used \
                  in production against its STATED specification. You are given recent \
                  runtime signals (errors, crashes, health failures, behavioral \
                  anomalies) and the current PRD and Plan pages. Identify where actual \
                  usage diverges from stated intent and propose a concrete, minimal \
                  specification delta a human can confirm or correct. Output Markdown \
                  with a '## Proposed spec delta' heading followed by bullet points. \
                  This is a PROPOSAL only — do not assume it will be applied automatically."
        .to_string();

    let user = format!(
        "Recent runtime signals (newest first):\n{signals_md}\n\n\
         Current PRD:\n{prd}\n\n\
         Current Plan:\n{plan}\n\n\
         Propose the specification delta implied by the gap between actual usage \
         and stated intent."
    );

    AgentRequest { system, user }
}

/// Run the IntentSpecInference step.
///
/// Reads recent runtime signals. With none, no-ops and returns an empty
/// [`StepOutcome`] so the cursor advances at zero cost. With signals present,
/// reads the `prd` / `plan` pages, asks the executor for a spec delta, and
/// writes it as a `spec-delta-proposal` page revision tagged as a
/// human-confirmation proposal, reporting the executor cost (issue #712).
pub(super) async fn run(
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
    executor: &dyn AgentExecutor,
) -> Result<StepOutcome, StepError> {
    let signals = sf_db::fetch_recent_runtime_signals(pool, SIGNAL_LIMIT).await?;

    // No-op path: no behavioral traces → nothing to infer. The loop commits the
    // cursor after we return Ok, so the step still advances at zero cost.
    if signals.is_empty() {
        return Ok(StepOutcome::default());
    }

    let prd = sf_db::fetch_page_content(pool, "prd")
        .await
        .unwrap_or(None)
        .unwrap_or_default();
    let plan = sf_db::fetch_page_content(pool, "plan")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let signals_md = render_signals(&signals);
    let req = build_request(&signals_md, &prd, &plan);

    let resp = executor.run(req).await?;

    // Provenance marks this unambiguously as a proposal awaiting human review —
    // it must never be confused with an applied spec change.
    let provenance = serde_json::json!({
        "step": "intent_spec_inference",
        "proposal": true,
        "requires_human_confirmation": true,
        "signal_count": signals.len(),
        "sources": resp.provenance,
    })
    .to_string();

    insert_page_revision(
        pool,
        workspace_id,
        SPEC_DELTA_PAGE,
        &resp.content,
        &provenance,
    )
    .await?;

    Ok(StepOutcome {
        cost_usd: resp.cost_usd,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::steps::GardeningStep;
    use chrono::Utc;

    fn signal(kind: &str, source: &str, message: &str) -> RuntimeSignalSummary {
        RuntimeSignalSummary {
            id: Uuid::new_v4(),
            signal_kind: kind.to_string(),
            source: source.to_string(),
            message: message.to_string(),
            recorded_at: Utc::now(),
        }
    }

    #[test]
    fn step_name_is_intent_spec_inference() {
        assert_eq!(
            GardeningStep::IntentSpecInference.name(),
            "intent_spec_inference"
        );
    }

    #[test]
    fn render_signals_emits_one_line_per_signal() {
        let signals = vec![
            signal("crash", "pod/api", "OOMKilled"),
            signal("behavior", "checkout", "users abandon at step 3"),
        ];
        let rendered = render_signals(&signals);
        assert_eq!(rendered.lines().count(), 2);
        assert!(rendered.contains("[crash] pod/api: OOMKilled"));
        assert!(rendered.contains("[behavior] checkout: users abandon at step 3"));
    }

    #[test]
    fn render_signals_empty_is_empty_string() {
        assert!(render_signals(&[]).is_empty());
    }

    #[test]
    fn build_request_includes_signals_prd_and_plan() {
        let req = build_request("- [error] x: boom\n", "PRD body", "PLAN body");
        assert!(req.system.contains("PROPOSAL"));
        assert!(req.user.contains("boom"));
        assert!(req.user.contains("PRD body"));
        assert!(req.user.contains("PLAN body"));
    }

    /// Integration: seeded signals emit a spec-delta artifact; none → no-op + cursor advance.
    ///
    /// Acceptance criteria (#709):
    /// - with seeded runtime signals the step emits a spec-delta artifact;
    /// - with none it no-ops (writes nothing) and the caller advances the cursor.
    ///
    /// Requires `DATABASE_URL` with nexum + sharp migrations applied.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum and sharp migrations"]
    async fn intent_spec_inference_seeded_vs_empty() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect");

        let workspace_id = Uuid::new_v4();
        let executor = crate::agent::FixtureAgentExecutor::new(
            "## Proposed spec delta\n\n- Tighten checkout step 3 copy.",
            "fixture:intent_spec_inference",
        );

        // --- Empty path: no signals → no-op, no artifact written. ---
        // Clear any pre-existing signals so this assertion is deterministic.
        sqlx::query("DELETE FROM sharp.runtime_signals")
            .execute(&pool)
            .await
            .ok();

        super::run(&pool, workspace_id, &executor)
            .await
            .expect("no-op path must succeed");
        assert_eq!(
            executor.call_count(),
            0,
            "no signals → executor must not be called"
        );
        let count_after_empty: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM nexum.page_revisions \
             WHERE workspace_id = $1 AND page_name = $2",
        )
        .bind(workspace_id)
        .bind(SPEC_DELTA_PAGE)
        .fetch_one(&pool)
        .await
        .expect("count");
        assert_eq!(count_after_empty, 0, "no-op path must write no artifact");

        // --- Seeded path: one signal → a spec-delta artifact is written. ---
        let episode_id = Uuid::new_v4();
        sqlx::query("INSERT INTO sharp.episodes (id, status) VALUES ($1, 'open')")
            .bind(episode_id)
            .execute(&pool)
            .await
            .expect("seed episode");
        sqlx::query(
            "INSERT INTO sharp.runtime_signals \
             (episode_id, signal_kind, source, message) \
             VALUES ($1, 'behavior', 'checkout', 'users abandon at step 3')",
        )
        .bind(episode_id)
        .execute(&pool)
        .await
        .expect("seed signal");

        super::run(&pool, workspace_id, &executor)
            .await
            .expect("inference path must succeed");
        assert_eq!(executor.call_count(), 1, "signals → executor called once");

        let prov: String = sqlx::query_scalar(
            "SELECT provenance FROM nexum.page_revisions \
             WHERE workspace_id = $1 AND page_name = $2 \
             ORDER BY ingested_at DESC LIMIT 1",
        )
        .bind(workspace_id)
        .bind(SPEC_DELTA_PAGE)
        .fetch_one(&pool)
        .await
        .expect("artifact row must exist");
        let meta: serde_json::Value = serde_json::from_str(&prov).expect("provenance JSON");
        assert_eq!(meta["proposal"], serde_json::json!(true));
        assert_eq!(meta["requires_human_confirmation"], serde_json::json!(true));

        // Cleanup.
        sqlx::query("DELETE FROM nexum.page_revisions WHERE workspace_id = $1 AND page_name = $2")
            .bind(workspace_id)
            .bind(SPEC_DELTA_PAGE)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM sharp.runtime_signals WHERE episode_id = $1")
            .bind(episode_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM sharp.episodes WHERE id = $1")
            .bind(episode_id)
            .execute(&pool)
            .await
            .ok();
    }
}
