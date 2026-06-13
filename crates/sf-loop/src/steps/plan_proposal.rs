//! Step 5: PlanProposal — derive implementation plan from architecture.
//!
//! Reads the architecture page and produces an implementation plan page
//! revision with phases, milestones, and task breakdown.

use crate::agent::{AgentExecutor, AgentRequest};
use crate::steps::StepError;
use sf_db::insert_page_revision;
use uuid::Uuid;

pub(super) async fn run(
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
    executor: &dyn AgentExecutor,
) -> Result<(), StepError> {
    let architecture = sf_db::fetch_page_content(pool, "architecture")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let existing_plan = sf_db::fetch_page_content(pool, "plan")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let system = "You are a project manager and technical lead. Derive a phased \
                  implementation plan from the architecture document. Break the plan \
                  into milestones with clear deliverables and acceptance criteria. \
                  Output the plan in Markdown.";

    let user = if existing_plan.is_empty() {
        format!("Architecture:\n{architecture}\n\nProduce the initial implementation plan.")
    } else {
        format!(
            "Architecture:\n{architecture}\n\n\
             Existing plan:\n{existing_plan}\n\n\
             Update the implementation plan to reflect the latest architecture."
        )
    };

    let req = AgentRequest {
        system: system.to_string(),
        user,
    };

    let resp = executor.run(req).await?;

    let provenance = serde_json::json!({
        "step": "plan_proposal",
        "sources": resp.provenance
    })
    .to_string();

    insert_page_revision(pool, workspace_id, "plan", &resp.content, &provenance).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::steps::GardeningStep;

    #[test]
    fn step_name() {
        assert_eq!(GardeningStep::PlanProposal.name(), "plan_proposal");
    }

    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL"]
    async fn plan_proposal_writes_page_revision() {
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
            .expect("plan_proposal must succeed");

        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM nexum.page_revisions WHERE workspace_id = $1 AND page_name = 'plan'",
        )
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("count");
        assert_eq!(count, 1);

        sqlx::query(
            "DELETE FROM nexum.page_revisions WHERE workspace_id = $1 AND page_name = 'plan'",
        )
        .bind(workspace_id)
        .execute(&pool)
        .await
        .ok();
    }
}
