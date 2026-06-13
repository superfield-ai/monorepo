//! Step 6: HolisticReconcile — re-read all five pages and propagate changes.
//!
//! Reads the strategy, prd, technical, architecture, and plan pages, then
//! detects any inconsistencies.  For each page where a change is detected,
//! writes a new page revision.
//!
//! # Acceptance criterion
//!
//! `holistic_reconcile_propagates_change`:
//! - Run with a fixture diff in one page.
//! - Assert the related page `page_revisions` row has a new version (count +1).

use crate::agent::{AgentExecutor, AgentRequest};
use crate::steps::StepError;
use sf_db::insert_page_revision;
use uuid::Uuid;

/// Pages that HolisticReconcile considers.
const RECONCILE_PAGES: &[&str] = &["strategy", "prd", "technical", "architecture", "plan"];

pub(super) async fn run(
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
    executor: &dyn AgentExecutor,
) -> Result<(), StepError> {
    // Read all pages.
    let mut contents: Vec<(&str, String)> = Vec::new();
    for page in RECONCILE_PAGES {
        let content = sf_db::fetch_page_content(pool, page)
            .await
            .unwrap_or(None)
            .unwrap_or_default();
        contents.push((page, content));
    }

    let all_pages = contents
        .iter()
        .map(|(name, c)| format!("## {name}\n\n{c}"))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    let system = "You are a systems thinker. Review all five knowledge-base pages \
                  (strategy, prd, technical, architecture, plan) holistically. \
                  For each page that requires an update to be consistent with the \
                  others, output a section titled '## UPDATE: <page_name>' followed \
                  by the full updated content of that page. Only output sections for \
                  pages that changed. If no changes are needed, output 'NO_CHANGES'.";

    let user = format!(
        "All current pages:\n\n{all_pages}\n\n\
         Identify inconsistencies and produce updates."
    );

    let req = AgentRequest {
        system: system.to_string(),
        user,
    };

    let resp = executor.run(req).await?;

    if resp.content.trim() == "NO_CHANGES" {
        return Ok(());
    }

    // Parse the response for "## UPDATE: <page_name>" sections.
    let updates = parse_updates(&resp.content);
    for (page_name, updated_content) in &updates {
        if RECONCILE_PAGES.contains(&page_name.as_str()) {
            let provenance = serde_json::json!({
                "step": "holistic_reconcile",
                "sources": resp.provenance
            })
            .to_string();
            insert_page_revision(pool, workspace_id, page_name, updated_content, &provenance)
                .await?;
        }
    }

    Ok(())
}

/// Parse `## UPDATE: <page_name>` sections from the LLM response.
fn parse_updates(content: &str) -> Vec<(String, String)> {
    let mut updates = Vec::new();
    let mut current_page: Option<String> = None;
    let mut current_content: Vec<&str> = Vec::new();

    for line in content.lines() {
        if line.starts_with("## UPDATE: ") {
            // Flush previous section.
            if let Some(ref page) = current_page {
                let text = current_content.join("\n").trim().to_string();
                if !text.is_empty() {
                    updates.push((page.clone(), text));
                }
                current_content.clear();
            }
            let page_name = line.trim_start_matches("## UPDATE: ").trim().to_lowercase();
            current_page = Some(page_name);
        } else if current_page.is_some() {
            current_content.push(line);
        }
    }

    // Flush last section.
    if let Some(ref page) = current_page {
        let text = current_content.join("\n").trim().to_string();
        if !text.is_empty() {
            updates.push((page.clone(), text));
        }
    }

    updates
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::steps::GardeningStep;

    #[test]
    fn step_name() {
        assert_eq!(GardeningStep::HolisticReconcile.name(), "holistic_reconcile");
    }

    #[test]
    fn parse_updates_single_section() {
        let content = "## UPDATE: strategy\nNew strategy content here.\nWith multiple lines.";
        let updates = parse_updates(content);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].0, "strategy");
        assert!(updates[0].1.contains("New strategy content"));
    }

    #[test]
    fn parse_updates_multiple_sections() {
        let content = "## UPDATE: strategy\nStrategy v2.\n## UPDATE: prd\nPRD v2.";
        let updates = parse_updates(content);
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].0, "strategy");
        assert_eq!(updates[1].0, "prd");
    }

    #[test]
    fn parse_updates_no_changes() {
        let updates = parse_updates("NO_CHANGES");
        assert!(updates.is_empty());
    }

    /// Integration: holistic_reconcile_propagates_change — acceptance criterion.
    ///
    /// Pre-insert a strategy page revision with a known discrepancy, run
    /// HolisticReconcile with a fixture executor that outputs an UPDATE section,
    /// then assert a new page revision row exists.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum migrations"]
    async fn holistic_reconcile_propagates_change() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect");

        let workspace_id = uuid::Uuid::new_v4();

        // Pre-insert a strategy page so the reconcile step has something to read.
        sf_db::insert_page_revision(
            &pool,
            workspace_id,
            "strategy",
            "# Old strategy",
            "test:setup",
        )
        .await
        .expect("pre-insert strategy");

        // Fixture executor returns an UPDATE for strategy.
        let fixture_content =
            "## UPDATE: strategy\n# Updated strategy\n\nReconciled with prd.".to_string();
        let executor =
            crate::agent::FixtureAgentExecutor::new(fixture_content, "fixture:holistic");

        // Count before.
        let before: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM nexum.page_revisions WHERE workspace_id = $1 AND page_name = 'strategy'",
        )
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("count before");

        run(&pool, workspace_id, &executor)
            .await
            .expect("holistic_reconcile must succeed");

        // Count after — must be before + 1.
        let after: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM nexum.page_revisions WHERE workspace_id = $1 AND page_name = 'strategy'",
        )
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("count after");

        assert_eq!(after, before + 1, "holistic reconcile must write a new revision");

        // Cleanup.
        sqlx::query(
            "DELETE FROM nexum.page_revisions WHERE workspace_id = $1",
        )
        .bind(workspace_id)
        .execute(&pool)
        .await
        .ok();
    }
}
