//! Step: ProjectGraphDerive — turn brain knowledge into Feature/Issue nodes.
//!
//! This is the loop side of issue #672 ("Step ④" of the product thesis:
//! knowledge becoming actionable work). Where the other gardening steps write
//! document *pages* (`nexum.page_revisions`), this step writes into the
//! **project graph** (`nexum.project_nodes` via [`sf_db::insert_issue`] /
//! [`sf_db::insert_feature`]), deriving tracked Issue nodes and their child
//! Feature nodes from the knowledge already in the brain (the `plan`, `prd`,
//! and `strategy` pages).
//!
//! # Derivation contract
//!
//! The step reads the current `plan` / `prd` / `strategy` page content, asks
//! the agent executor to emit a flat, line-oriented derivation, and parses it
//! with [`parse_derivation`]:
//!
//! ```text
//! ISSUE: <issue title>
//! FEATURE: <feature title>
//! FEATURE: <another feature under the same issue>
//! ISSUE: <next issue title>
//! FEATURE: ...
//! ```
//!
//! Each `ISSUE:` line inserts an Issue node; each following `FEATURE:` line
//! inserts a Feature node linked to the most recently seen Issue (skipped if
//! no issue has appeared yet). Created nodes read back through the existing
//! `GET /pages/project` projection.
//!
//! # Idempotency
//!
//! Re-running the step inserts fresh nodes each pass (project-node inserts are
//! not upserts), so the loop derives from knowledge that has *not yet* been
//! turned into a node. The step skips insertion when the parsed derivation is
//! empty (no `ISSUE:` lines), leaving the cursor to advance without writing.

use crate::agent::{AgentExecutor, AgentRequest};
use crate::steps::{StepError, StepOutcome};
use uuid::Uuid;

/// A parsed derivation: a list of issues, each with its child feature titles.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Derivation {
    /// One entry per `ISSUE:` line: `(issue_title, [feature_title, ...])`.
    pub issues: Vec<(String, Vec<String>)>,
}

/// Parse the agent's line-oriented derivation output.
///
/// Recognises `ISSUE:` and `FEATURE:` prefixes (case-insensitive, leading
/// markdown bullet / whitespace tolerated). Blank titles are ignored.
/// `FEATURE:` lines before the first `ISSUE:` line are dropped.
pub(crate) fn parse_derivation(text: &str) -> Derivation {
    let mut derivation = Derivation::default();

    for raw in text.lines() {
        // Strip leading whitespace and common markdown bullets (-, *, +).
        let line = raw.trim_start_matches([' ', '\t', '-', '*', '+']).trim();

        if let Some(rest) = strip_prefix_ci(line, "ISSUE:") {
            let title = rest.trim();
            if !title.is_empty() {
                derivation.issues.push((title.to_string(), Vec::new()));
            }
        } else if let Some(rest) = strip_prefix_ci(line, "FEATURE:") {
            let title = rest.trim();
            if let Some((_issue, features)) = derivation.issues.last_mut() {
                if !title.is_empty() {
                    features.push(title.to_string());
                }
            }
            // FEATURE before any ISSUE → dropped.
        }
    }

    derivation
}

/// Case-insensitive prefix strip. Returns the remainder if `s` starts with
/// `prefix` (ignoring ASCII case), else `None`.
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

/// Run the ProjectGraphDerive step.
///
/// Reads the brain's knowledge pages, asks the executor for a Feature/Issue
/// derivation, parses it, and writes the resulting nodes through the project
/// graph. Returns `Ok(())` even when nothing is derived (the cursor still
/// advances).
pub(super) async fn run(
    pool: &sqlx::PgPool,
    _workspace_id: Uuid,
    executor: &dyn AgentExecutor,
) -> Result<StepOutcome, StepError> {
    let plan = sf_db::fetch_page_content(pool, "plan")
        .await
        .unwrap_or(None)
        .unwrap_or_default();
    let prd = sf_db::fetch_page_content(pool, "prd")
        .await
        .unwrap_or(None)
        .unwrap_or_default();
    let strategy = sf_db::fetch_page_content(pool, "strategy")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let system = "You are a delivery lead. Turn the project's knowledge base into a flat list \
                  of tracked work items. Emit one item per line using exactly this format:\n\
                  ISSUE: <short issue title>\n\
                  FEATURE: <short feature title scoped to the issue above>\n\
                  Group features under the issue they belong to by listing the ISSUE line \
                  first, then its FEATURE lines. Derive at least one ISSUE with one child \
                  FEATURE. Output only ISSUE: and FEATURE: lines — no prose, no headings.";

    let user = format!(
        "Plan:\n{plan}\n\nPRD:\n{prd}\n\nStrategy:\n{strategy}\n\n\
         Derive the Feature and Issue work items from this knowledge."
    );

    let resp = executor
        .run(AgentRequest {
            system: system.to_string(),
            user,
        })
        .await?;

    let derivation = parse_derivation(&resp.content);

    for (issue_title, feature_titles) in &derivation.issues {
        let issue_id = sf_db::insert_issue(pool, issue_title, None).await?;
        for feature_title in feature_titles {
            sf_db::insert_feature(pool, issue_id, feature_title).await?;
        }
    }

    Ok(StepOutcome {
        cost_usd: resp.cost_usd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::steps::GardeningStep;

    #[test]
    fn step_name() {
        assert_eq!(
            GardeningStep::ProjectGraphDerive.name(),
            "project_graph_derive"
        );
    }

    #[test]
    fn parse_basic_issue_with_features() {
        let text = "ISSUE: Login flow\nFEATURE: Email login\nFEATURE: SSO login\n";
        let d = parse_derivation(text);
        assert_eq!(d.issues.len(), 1);
        assert_eq!(d.issues[0].0, "Login flow");
        assert_eq!(d.issues[0].1, vec!["Email login", "SSO login"]);
    }

    #[test]
    fn parse_multiple_issues() {
        let text = "ISSUE: A\nFEATURE: A1\nISSUE: B\nFEATURE: B1\nFEATURE: B2";
        let d = parse_derivation(text);
        assert_eq!(d.issues.len(), 2);
        assert_eq!(d.issues[0].1, vec!["A1"]);
        assert_eq!(d.issues[1].1, vec!["B1", "B2"]);
    }

    #[test]
    fn parse_tolerates_bullets_and_case() {
        let text = "- issue: Lower\n  * Feature: Indented feature";
        let d = parse_derivation(text);
        assert_eq!(d.issues.len(), 1);
        assert_eq!(d.issues[0].0, "Lower");
        assert_eq!(d.issues[0].1, vec!["Indented feature"]);
    }

    #[test]
    fn parse_drops_feature_before_issue_and_blanks() {
        let text = "FEATURE: orphan\nISSUE:\nISSUE: Real\nFEATURE:\nFEATURE: Kept";
        let d = parse_derivation(text);
        assert_eq!(d.issues.len(), 1);
        assert_eq!(d.issues[0].0, "Real");
        assert_eq!(d.issues[0].1, vec!["Kept"]);
    }

    #[test]
    fn parse_empty_yields_no_issues() {
        let d = parse_derivation("no structured lines here\njust prose");
        assert!(d.issues.is_empty());
    }

    /// Integration: seeded knowledge yields Feature/Issue nodes after a pass.
    ///
    /// Acceptance criterion: seeded knowledge yields Feature/Issue nodes after
    /// a loop pass.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum migrations applied"]
    async fn project_graph_derive_writes_nodes() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect");

        let workspace_id = uuid::Uuid::new_v4();
        let executor = crate::agent::FixtureAgentExecutor::new(
            "ISSUE: Integration test issue\nFEATURE: Integration test feature",
            "fixture:project_graph_derive",
        );

        super::run(&pool, workspace_id, &executor)
            .await
            .expect("project_graph_derive must succeed");

        // The derived issue must read back through the project page projection.
        let page = sf_db::fetch_project_page(&pool)
            .await
            .expect("fetch_project_page")
            .unwrap_or_default();
        assert!(
            page.contains("Integration test issue") && page.contains("Integration test feature"),
            "projection must contain the derived nodes, got: {page}"
        );

        // Cleanup: delete the nodes/blocks/links we created.
        let issues = sf_db::list_nodes(&pool, Some("Issue"))
            .await
            .expect("list issues");
        for node in issues
            .iter()
            .filter(|n| n.content == "Integration test issue")
        {
            sqlx::query("DELETE FROM nexum.links WHERE src = $1 OR dst = $1")
                .bind(node.block_id)
                .execute(&pool)
                .await
                .ok();
        }
        let features = sf_db::list_nodes(&pool, Some("Feature"))
            .await
            .expect("list features");
        for node in features
            .iter()
            .filter(|n| n.content == "Integration test feature")
        {
            sqlx::query("DELETE FROM nexum.links WHERE src = $1 OR dst = $1")
                .bind(node.block_id)
                .execute(&pool)
                .await
                .ok();
            sqlx::query("DELETE FROM nexum.project_nodes WHERE id = $1")
                .bind(node.id)
                .execute(&pool)
                .await
                .ok();
            sqlx::query("DELETE FROM nexum.blocks WHERE id = $1")
                .bind(node.block_id)
                .execute(&pool)
                .await
                .ok();
        }
        for node in issues
            .iter()
            .filter(|n| n.content == "Integration test issue")
        {
            sqlx::query("DELETE FROM nexum.project_nodes WHERE id = $1")
                .bind(node.id)
                .execute(&pool)
                .await
                .ok();
            sqlx::query("DELETE FROM nexum.blocks WHERE id = $1")
                .bind(node.block_id)
                .execute(&pool)
                .await
                .ok();
        }
    }
}
