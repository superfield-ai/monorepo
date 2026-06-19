//! Step 2: PrdReconcile — reconcile the PRD against strategy research.
//!
//! Reads the current "strategy" and "prd" pages, then produces an updated
//! PRD that is consistent with the latest strategy findings.

use crate::agent::{AgentExecutor, AgentRequest};
use crate::steps::{StepError, StepOutcome};
use sf_db::insert_page_revision;
use uuid::Uuid;

pub(super) async fn run(
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
    executor: &dyn AgentExecutor,
) -> Result<StepOutcome, StepError> {
    let strategy = sf_db::fetch_page_content(pool, "strategy")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let existing_prd = sf_db::fetch_page_content(pool, "prd")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let system = "You are a product manager. Reconcile the Product Requirements Document \
                  with the latest strategy research. Preserve all existing requirements \
                  that remain valid; update or remove those superseded by the strategy.";

    let user = format!(
        "Strategy research:\n{strategy}\n\n\
         Existing PRD:\n{existing_prd}\n\n\
         Produce an updated PRD in Markdown."
    );

    let req = AgentRequest {
        system: system.to_string(),
        user,
    };

    let resp = executor.run(req).await?;

    let provenance = serde_json::json!({
        "step": "prd_reconcile",
        "sources": resp.provenance
    })
    .to_string();

    insert_page_revision(pool, workspace_id, "prd", &resp.content, &provenance).await?;

    Ok(StepOutcome {
        cost_usd: resp.cost_usd,
    })
}

#[cfg(test)]
mod tests {
    use crate::steps::GardeningStep;

    #[test]
    fn step_name() {
        assert_eq!(GardeningStep::PrdReconcile.name(), "prd_reconcile");
    }

    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL"]
    async fn prd_reconcile_writes_page_revision() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect");

        let workspace_id = uuid::Uuid::new_v4();
        let executor = crate::agent::FixtureAgentExecutor::default();

        super::run(&pool, workspace_id, &executor)
            .await
            .expect("prd_reconcile must succeed");

        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM nexum.page_revisions WHERE workspace_id = $1 AND page_name = 'prd'",
        )
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("count");
        assert_eq!(count, 1);

        sqlx::query(
            "DELETE FROM nexum.page_revisions WHERE workspace_id = $1 AND page_name = 'prd'",
        )
        .bind(workspace_id)
        .execute(&pool)
        .await
        .ok();
    }
}
