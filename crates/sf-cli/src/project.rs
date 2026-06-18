//! `superfield issue ...` / `superfield feature ...` — project-graph verbs.
//!
//! These commands let a human create and list Feature/Issue project-graph
//! nodes from the CLI surface, mirroring the `POST /studio/issues` HTTP route
//! and the gardening-loop derivation step (issue #672). They write through the
//! same [`sf_db`] project-graph API (`insert_issue` / `insert_feature` /
//! `list_nodes`), so created nodes read back through `GET /pages/project` and
//! `superfield page project`.
//!
//! # Verbs
//!
//! | Command                                  | Action                       |
//! |------------------------------------------|------------------------------|
//! | `issue create <title> [external-ref]`    | Insert an Issue node         |
//! | `issue list`                             | List Issue nodes             |
//! | `feature create <issue-id> <title>`      | Insert a Feature under Issue  |
//! | `feature list`                           | List Feature nodes           |

use sf_db::ProjectGraphError;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

/// Errors from the `issue` / `feature` commands.
#[derive(Debug, Error)]
pub enum ProjectError {
    /// A project-graph write/read error.
    #[error("project graph error: {0}")]
    Graph(#[from] ProjectGraphError),
}

/// `superfield issue create <title> [external-ref]` — insert an Issue node.
///
/// Prints the new `project_nodes.id` on success.
pub async fn issue_create(
    pool: &PgPool,
    title: &str,
    external_ref: Option<&str>,
) -> Result<(), ProjectError> {
    let id = sf_db::insert_issue(pool, title, external_ref).await?;
    println!("{id}");
    Ok(())
}

/// `superfield feature create <issue-id> <title>` — insert a Feature node
/// linked to the given parent Issue.
///
/// Prints the new `project_nodes.id` on success.
pub async fn feature_create(
    pool: &PgPool,
    issue_id: Uuid,
    title: &str,
) -> Result<(), ProjectError> {
    let id = sf_db::insert_feature(pool, issue_id, title).await?;
    println!("{id}");
    Ok(())
}

/// `superfield issue list` / `superfield feature list` — list nodes of one
/// type, newest first, as tab-separated `id<TAB>state<TAB>title` lines.
pub async fn list(pool: &PgPool, node_type: &str) -> Result<(), ProjectError> {
    let nodes = sf_db::list_nodes(pool, Some(node_type)).await?;
    for node in &nodes {
        println!("{}\t{}\t{}", node.id, node.state, node.content);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Integration test: create an issue, then list it back.
    ///
    /// Acceptance criterion (CLI test): create then list shows the new nodes.
    /// Skipped unless `DATABASE_URL` is set with the nexum schema migrated.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum migrations applied"]
    async fn issue_create_then_list() {
        let cfg = sf_db::DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = sf_db::connect(&cfg).await.expect("pool creation failed");

        let marker = format!("cli-test-issue-{}", Uuid::new_v4());
        let issue_id = sf_db::insert_issue(&pool, &marker, None)
            .await
            .expect("insert_issue");

        let _feature_id = sf_db::insert_feature(&pool, issue_id, "cli-test-feature")
            .await
            .expect("insert_feature");

        let issues = sf_db::list_nodes(&pool, Some("Issue"))
            .await
            .expect("list issues");
        assert!(
            issues.iter().any(|n| n.content == marker),
            "created issue must appear in the list"
        );

        // Cleanup.
        for node in issues.iter().filter(|n| n.content == marker) {
            sqlx::query("DELETE FROM nexum.links WHERE src = $1 OR dst = $1")
                .bind(node.block_id)
                .execute(&pool)
                .await
                .ok();
        }
        let features = sf_db::list_nodes(&pool, Some("Feature"))
            .await
            .expect("list features");
        for node in features.iter().filter(|n| n.content == "cli-test-feature") {
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
        for node in issues.iter().filter(|n| n.content == marker) {
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
