//! Page query — read projection over the Nexum graph.
//!
//! Implements [`fetch_page_content`]: the single read entrypoint for the pages
//! projection layer (issue #492).  A "page" is a named document stored in the
//! `nexum.documents` table (by title) whose latest version's blocks are
//! rendered as markdown.
//!
//! # Registry
//!
//! The following page names are recognised:
//!
//! | Name           | Nexum document title                   |
//! |----------------|----------------------------------------|
//! | `prd`          | `prd`                                  |
//! | `architecture` | `architecture`                         |
//! | `plan`         | `plan`                                 |
//! | `strategy`     | `strategy`                             |
//! | `project`      | `project`                              |
//!
//! # Query design
//!
//! 1. Look up `nexum.documents` by `title = page_name`.
//! 2. Find the latest `nexum.document_versions` row for that document
//!    (highest `id` / latest `ingested_at`).
//! 3. Fetch all `nexum.blocks` for that version via `nexum.version_blocks`,
//!    ordered by `seq`.
//! 4. Concatenate block content as markdown and return it.
//!
//! Returns `Ok(None)` when the document or version does not exist yet (the
//! gardening loop has not produced a page revision for this name).
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Nexum — page-revision schema.
//! - Issue #492 scope.

use sqlx::PgPool;
use thiserror::Error;

/// Recognised page names in the page registry.
///
/// Only these names are accepted by [`fetch_page_content`]; any other name
/// is rejected with [`PageQueryError::UnknownPage`].
pub const KNOWN_PAGES: &[&str] = &["prd", "architecture", "plan", "strategy", "project"];

/// Errors that can occur during a page query.
#[derive(Debug, Error)]
pub enum PageQueryError {
    /// A database error from sqlx.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The caller requested a page name that is not in the registry.
    #[error("unknown page '{0}'; known pages: prd, architecture, plan, strategy, project")]
    UnknownPage(String),
}

/// Fetch the current markdown content of a named page from the Nexum graph.
///
/// # Arguments
///
/// * `pool`      — the shared [`sqlx::PgPool`] from `sf-db`.
/// * `page_name` — a name from the page registry (e.g. `"prd"`).
///
/// # Returns
///
/// - `Ok(Some(markdown))` — the page exists and has at least one version with
///   blocks; the blocks are concatenated in sequence order.
/// - `Ok(None)` — the document or version does not exist in the database yet
///   (the gardening loop has not yet produced a page revision for this name).
/// - `Err(PageQueryError::UnknownPage)` — `page_name` is not in the registry.
/// - `Err(PageQueryError::Database)` — a Postgres query failed.
///
/// # Implementation note
///
/// This function queries `nexum.documents` by `title` (not `external_id`),
/// following the convention established by the `insert_page_revision` stub in
/// `sf-db::page_revision`.  The latest version is determined by the highest
/// `id` (UUID v4, lexicographically monotone within a single session) — in
/// practice `ingested_at` would also work, but `id` is more reliably unique.
pub async fn fetch_page_content(
    pool: &PgPool,
    page_name: &str,
) -> Result<Option<String>, PageQueryError> {
    // Validate against the known registry first so callers get a clear error.
    if !KNOWN_PAGES.contains(&page_name) {
        return Err(PageQueryError::UnknownPage(page_name.to_string()));
    }

    // Step 1: find the document by title.
    let doc_id: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM nexum.documents WHERE title = $1 LIMIT 1")
            .bind(page_name)
            .fetch_optional(pool)
            .await?;

    let doc_id = match doc_id {
        Some(id) => id,
        None => return Ok(None),
    };

    // Step 2: find the latest version for that document.
    let version_id: Option<uuid::Uuid> = sqlx::query_scalar(
        "SELECT id FROM nexum.document_versions \
         WHERE doc_id = $1 \
         ORDER BY ingested_at DESC, id DESC \
         LIMIT 1",
    )
    .bind(doc_id)
    .fetch_optional(pool)
    .await?;

    let version_id = match version_id {
        Some(id) => id,
        None => return Ok(None),
    };

    // Step 3: fetch blocks for this version in sequence order.
    let blocks: Vec<String> = sqlx::query_scalar(
        "SELECT b.content \
         FROM nexum.blocks b \
         JOIN nexum.version_blocks vb ON vb.block_id = b.id \
         WHERE vb.version_id = $1 \
         ORDER BY vb.seq ASC",
    )
    .bind(version_id)
    .fetch_all(pool)
    .await?;

    if blocks.is_empty() {
        return Ok(None);
    }

    // Step 4: join blocks with double-newline separators (markdown convention).
    Ok(Some(blocks.join("\n\n")))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Unit test: `fetch_page_content` rejects unknown page names without touching the DB.
    ///
    /// This is a pure-unit test — no database required.
    #[tokio::test]
    async fn unknown_page_name_returns_error() {
        let pool = sqlx::PgPool::connect_lazy("postgres://localhost/stub_db_never_connects")
            .expect("lazy connect should not fail");

        let err = fetch_page_content(&pool, "nonexistent").await.unwrap_err();
        match err {
            PageQueryError::UnknownPage(name) => assert_eq!(name, "nonexistent"),
            other => panic!("expected UnknownPage, got {:?}", other),
        }
    }

    /// Unit test: all known page names pass the registry guard.
    ///
    /// This test confirms that the constants in [`KNOWN_PAGES`] match what
    /// `fetch_page_content` accepts.  It does not require a database because
    /// it only checks the guard — not the SQL.
    ///
    /// A `Database` error is expected for all names (the lazy pool will fail
    /// when the SQL is attempted), but `UnknownPage` must NOT be returned.
    #[tokio::test]
    async fn known_page_names_pass_registry_guard() {
        let pool = sqlx::PgPool::connect_lazy("postgres://localhost/stub_db_never_connects")
            .expect("lazy connect should not fail");

        for name in KNOWN_PAGES {
            let result = fetch_page_content(&pool, name).await;
            // The lazy pool will produce a database error when the SQL is
            // attempted, but it must NOT be an UnknownPage error.
            match result {
                Err(PageQueryError::UnknownPage(n)) => {
                    panic!(
                        "'{}' should be a known page but got UnknownPage('{}')",
                        name, n
                    )
                }
                // Database error is expected (no real DB) — test passes.
                Err(PageQueryError::Database(_)) | Ok(_) => {}
            }
        }
    }

    /// Integration test: fetch latest version for a named page.
    ///
    /// Inserts two document_versions for the same document; asserts that the
    /// query returns only the content from the later version.
    ///
    /// Skipped unless `DATABASE_URL` is set with the nexum schema migrated.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum schema migrated"]
    async fn page_query_returns_latest_version() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");

        // Insert a corpus (required FK).
        let corpus_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.corpora (name) VALUES ('test-page-query') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .expect("corpus insert failed");

        // Insert a document with title 'prd'.
        let doc_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.documents (corpus_id, title) VALUES ($1, 'prd') RETURNING id",
        )
        .bind(corpus_id)
        .fetch_one(&pool)
        .await
        .expect("document insert failed");

        // Insert version 1 with one block containing 'v1 content'.
        let ver1_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.document_versions (doc_id, version_num, status) \
             VALUES ($1, 1, 'done') RETURNING id",
        )
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("version 1 insert failed");

        let block1_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type) \
             VALUES ($1, 'v1 content', 'hash_v1', 'paragraph') RETURNING id",
        )
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("block v1 insert failed");

        sqlx::query(
            "INSERT INTO nexum.version_blocks (version_id, block_id, seq) VALUES ($1, $2, 0)",
        )
        .bind(ver1_id)
        .bind(block1_id)
        .execute(&pool)
        .await
        .expect("version_block v1 insert failed");

        // Insert version 2 (later) with a block containing 'v2 content'.
        let ver2_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.document_versions (doc_id, version_num, status) \
             VALUES ($1, 2, 'done') RETURNING id",
        )
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("version 2 insert failed");

        let block2_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type) \
             VALUES ($1, 'v2 content', 'hash_v2', 'paragraph') RETURNING id",
        )
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("block v2 insert failed");

        sqlx::query(
            "INSERT INTO nexum.version_blocks (version_id, block_id, seq) VALUES ($1, $2, 0)",
        )
        .bind(ver2_id)
        .bind(block2_id)
        .execute(&pool)
        .await
        .expect("version_block v2 insert failed");

        // Query — must return v2 content, not v1 content.
        let content = fetch_page_content(&pool, "prd")
            .await
            .expect("fetch failed")
            .expect("expected Some");

        assert!(
            content.contains("v2 content"),
            "expected v2 content in result, got: {:?}",
            content
        );
        assert!(
            !content.contains("v1 content"),
            "v1 content must not appear in latest-version result, got: {:?}",
            content
        );

        // Cleanup — delete in reverse dependency order.
        sqlx::query("DELETE FROM nexum.version_blocks WHERE version_id IN ($1, $2)")
            .bind(ver1_id)
            .bind(ver2_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.document_versions WHERE doc_id = $1")
            .bind(doc_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.blocks WHERE doc_id = $1")
            .bind(doc_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.documents WHERE id = $1")
            .bind(doc_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.corpora WHERE id = $1")
            .bind(corpus_id)
            .execute(&pool)
            .await
            .ok();
    }
}
