//! Step 3: TechnicalResearch — research technical implementations.
//!
//! Reads the current PRD and produces a page revision documenting relevant
//! technical approaches, constraints, and trade-offs.

use crate::agent::{AgentExecutor, AgentRequest};
use crate::steps::StepError;
use sf_db::insert_page_revision;
use uuid::Uuid;

pub(super) async fn run(
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
    executor: &dyn AgentExecutor,
) -> Result<(), StepError> {
    let prd = sf_db::fetch_page_content(pool, "prd")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let existing_technical = sf_db::fetch_page_content(pool, "technical")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let system = "You are a senior software engineer. Research technical implementations, \
                  libraries, frameworks, and constraints relevant to the PRD. \
                  Document trade-offs and recommendations in Markdown.";

    let user = if existing_technical.is_empty() {
        format!("PRD:\n{prd}\n\nProduce initial technical research.")
    } else {
        format!(
            "PRD:\n{prd}\n\n\
             Existing technical research:\n{existing_technical}\n\n\
             Update the technical research based on the latest PRD."
        )
    };

    let req = AgentRequest {
        system: system.to_string(),
        user,
    };

    let resp = executor.run(req).await?;

    let provenance = serde_json::json!({
        "step": "technical_research",
        "sources": resp.provenance
    })
    .to_string();

    insert_page_revision(pool, workspace_id, "technical", &resp.content, &provenance).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::steps::GardeningStep;

    #[test]
    fn step_name() {
        assert_eq!(GardeningStep::TechnicalResearch.name(), "technical_research");
    }

    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL"]
    async fn technical_research_writes_page_revision() {
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
            .expect("technical_research must succeed");

        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM nexum.page_revisions WHERE workspace_id = $1 AND page_name = 'technical'",
        )
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("count");
        assert_eq!(count, 1);

        sqlx::query(
            "DELETE FROM nexum.page_revisions WHERE workspace_id = $1 AND page_name = 'technical'",
        )
        .bind(workspace_id)
        .execute(&pool)
        .await
        .ok();
    }
}
