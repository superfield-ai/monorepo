//! Step 1: StrategyResearch — research company strategy.
//!
//! Reads the seed "strategy" page (if any) and produces a new page revision
//! describing the company's strategic context.  This is the first step in
//! each gardening pass and sets the context for all subsequent steps.
//!
//! # Acceptance criterion
//!
//! `strategy_step_writes_page_revision_with_provenance`:
//! - Run with a [`FixtureAgentExecutor`].
//! - Assert `nexum.page_revisions` has a new row for `"strategy"` with
//!   metadata JSON containing `"step"` and `"sources"` keys.

use crate::agent::{AgentExecutor, AgentRequest};
use crate::steps::StepError;
use sf_db::insert_page_revision;
use uuid::Uuid;

pub(super) async fn run(
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
    executor: &dyn AgentExecutor,
) -> Result<(), StepError> {
    // Read existing strategy page content (may be empty on first run).
    let existing = sf_db::fetch_page_content(pool, "strategy")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let system = "You are a strategy researcher. Analyse the company's background, \
                  mission, and competitive landscape. Produce a concise strategy summary \
                  in Markdown with a 'Sources' section listing any referenced documents.";

    let user = if existing.is_empty() {
        "Research the company strategy. Produce an initial strategy page.".to_string()
    } else {
        format!(
            "Update the company strategy page based on the latest understanding.\n\n\
             Existing strategy:\n{existing}"
        )
    };

    let req = AgentRequest {
        system: system.to_string(),
        user,
    };

    let resp = executor.run(req).await?;

    // Embed step + sources metadata in the provenance tag as JSON.
    let provenance = serde_json::json!({
        "step": "strategy_research",
        "sources": resp.provenance
    })
    .to_string();

    insert_page_revision(pool, workspace_id, "strategy", &resp.content, &provenance).await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::agent::FixtureAgentExecutor;
    use crate::steps::GardeningStep;

    #[test]
    fn step_name_is_strategy_research() {
        assert_eq!(GardeningStep::StrategyResearch.name(), "strategy_research");
    }

    /// Integration: strategy_step_writes_page_revision_with_provenance.
    ///
    /// Acceptance criterion — requires `DATABASE_URL`.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum and orchestrator migrations"]
    async fn strategy_step_writes_page_revision_with_provenance() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect");

        let workspace_id = uuid::Uuid::new_v4();
        let executor = FixtureAgentExecutor::default();

        super::run(&pool, workspace_id, &executor)
            .await
            .expect("strategy step must succeed");

        // Assert: a page_revision row exists for "strategy" with provenance containing "step" and "sources".
        let prov: String = sqlx::query_scalar(
            "SELECT provenance FROM nexum.page_revisions \
             WHERE workspace_id = $1 AND page_name = 'strategy' \
             ORDER BY ingested_at DESC LIMIT 1",
        )
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("must find row");

        let meta: serde_json::Value = serde_json::from_str(&prov).expect("provenance is JSON");
        assert!(meta.get("step").is_some(), "provenance must contain 'step'");
        assert!(meta.get("sources").is_some(), "provenance must contain 'sources'");

        // Cleanup.
        sqlx::query(
            "DELETE FROM nexum.page_revisions WHERE workspace_id = $1 AND page_name = 'strategy'",
        )
        .bind(workspace_id)
        .execute(&pool)
        .await
        .ok();
    }
}
