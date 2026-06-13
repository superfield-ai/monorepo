//! Page-revision write path — implementation for the gardening loop write path.
//!
//! Defines [`insert_page_revision`], the single write entrypoint through which
//! the gardening loop engine (issue #491) persists computed page revisions to
//! the shared Postgres substrate. Nexum (issue #490) calls this function when
//! updating a page during document ingestion.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Nexum — page-revision schema and write contract.
//! - `docs/prd.md` — gardening appliance page model.
//!
//! # Seam contract
//!
//! The caller provides:
//! - `pool`         — the shared [`sqlx::PgPool`] from `sf-db`.
//! - `workspace_id` — the workspace UUID that owns this revision (required for
//!   per-workspace RLS and application-layer filtering, per issue #429).
//! - `page_name`    — the human-readable page identifier (e.g. `"company-background"`).
//! - `content`      — the rendered Markdown/plain-text content of the revision.
//! - `provenance`   — a free-text provenance tag (e.g. a document URL or agent ID).
//!
//! The function returns `Ok(())` on success.
//!
//! # Schema
//!
//! The `nexum.page_revisions` table is created by
//! `crates/nexum/migrations/0003_page_revisions.sql` (issue #490).  That
//! migration must be applied before calling this function against a live
//! database.
//!
//! # Idempotency
//!
//! Each call inserts a new row.  The query layer selects the latest row by
//! `(workspace_id, page_name, ingested_at DESC)` so re-runs append a new
//! revision without corrupting the history.

use uuid::Uuid;

/// Error type for page-revision write operations.
#[derive(Debug, thiserror::Error)]
pub enum PageRevisionError {
    /// A database error from sqlx.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The page_revisions table does not exist yet (migration not applied).
    #[error("page_revisions table not found — apply nexum migrations first")]
    TableMissing,
}

/// Insert a new page revision into the shared substrate.
///
/// Writes one row to `nexum.page_revisions` containing the rendered content
/// and provenance tag.  The row is stamped with the current timestamp.
///
/// # Arguments
///
/// * `pool`         — shared [`sqlx::PgPool`].
/// * `workspace_id` — tenant UUID; must exist in `public.workspaces(id)`.
/// * `page_name`    — human-readable page identifier (e.g. `"company-background"`).
/// * `content`      — rendered page content (Markdown or plain text).
/// * `provenance`   — free-text provenance tag (agent ID, document URL, etc.).
///
/// # Errors
///
/// Returns [`PageRevisionError::Database`] on Postgres errors.
/// Returns [`PageRevisionError::TableMissing`] when the migration has not
/// been applied (detected by checking the error message for the table name).
pub async fn insert_page_revision(
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
    page_name: &str,
    content: &str,
    provenance: &str,
) -> Result<(), PageRevisionError> {
    let result = sqlx::query(
        r#"
        INSERT INTO nexum.page_revisions
            (workspace_id, page_name, content, provenance)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(workspace_id)
    .bind(page_name)
    .bind(content)
    .bind(provenance)
    .execute(pool)
    .await;

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            // Detect "table does not exist" and surface a friendlier error.
            let msg = e.to_string();
            if msg.contains("page_revisions") && msg.contains("does not exist") {
                Err(PageRevisionError::TableMissing)
            } else {
                Err(PageRevisionError::Database(e))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Integration test: insert_page_revision writes a row to the DB.
    ///
    /// Requires `DATABASE_URL` with the nexum schema and page_revisions table
    /// migrated.  Skipped unless the env var is set.
    ///
    /// Acceptance criterion: covers the write path that was previously a stub.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum migrations applied"]
    async fn insert_page_revision_writes_row() {
        let url = match std::env::var("DATABASE_URL") {
            Ok(u) => u,
            Err(_) => return,
        };
        let workspace_id_str = match std::env::var("WORKSPACE_ID") {
            Ok(u) => u,
            Err(_) => return,
        };
        let workspace_id: Uuid = workspace_id_str
            .parse()
            .expect("WORKSPACE_ID must be a UUID");

        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .expect("connect failed");

        let page_name = format!("test-page-{}", Uuid::new_v4());
        let content = "# Test Page\n\nThis is test content.";
        let provenance = "test-scout-490";

        insert_page_revision(&pool, workspace_id, &page_name, content, provenance)
            .await
            .expect("insert_page_revision must succeed");

        // Verify the row was written.
        let row_content: String = sqlx::query_scalar(
            "SELECT content FROM nexum.page_revisions \
             WHERE page_name = $1 AND workspace_id = $2 \
             ORDER BY ingested_at DESC LIMIT 1",
        )
        .bind(&page_name)
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("row must exist after insert");

        assert_eq!(row_content, content);

        // Cleanup.
        sqlx::query("DELETE FROM nexum.page_revisions WHERE page_name = $1 AND workspace_id = $2")
            .bind(&page_name)
            .bind(workspace_id)
            .execute(&pool)
            .await
            .ok();
    }
}
