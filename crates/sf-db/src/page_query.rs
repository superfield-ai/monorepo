//! Page query — read projection over `nexum.page_revisions`.
//!
//! Implements [`fetch_page_content`]: the single read entrypoint for the pages
//! projection layer (issue #492).  A "page" is a named document produced by
//! the gardening loop and stored as the latest row in `nexum.page_revisions`.
//!
//! # Registry
//!
//! The following page names are recognised:
//!
//! | Name           | Content source                                      |
//! |----------------|-----------------------------------------------------|
//! | `prd`          | `nexum.page_revisions` for page name `prd`          |
//! | `architecture` | `nexum.page_revisions` for page name `architecture` |
//! | `plan`         | `nexum.page_revisions` for page name `plan`         |
//! | `strategy`     | `nexum.page_revisions` for page name `strategy`     |
//! | `technical`    | `nexum.page_revisions` for page name `technical`    |
//! | `project`      | `nexum.page_revisions` for page name `project`      |
//! | `spec-delta-proposal` | `nexum.page_revisions` for `spec-delta-proposal` |
//!
//! # Query design
//!
//! `fetch_page_content` performs a single-table lookup:
//!
//! ```sql
//! SELECT content
//! FROM nexum.page_revisions
//! WHERE page_name = $1
//! ORDER BY ingested_at DESC
//! LIMIT 1
//! ```
//!
//! The read path is workspace-agnostic: it returns the most recent revision
//! for a given `page_name` regardless of which workspace produced it.  This
//! matches the gardening loop contract — loop steps append rows via
//! `insert_page_revision` and the reader always sees the latest.
//!
//! Returns `Ok(None)` when no revision exists yet for the requested name (the
//! gardening loop has not yet produced a page revision for this name).
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Nexum — page-revision schema.
//! - Issue #492 scope, issue #547 decision: Option A (`nexum.page_revisions`
//!   is the canonical source for `fetch_page_content`).

use sqlx::PgPool;
use thiserror::Error;

/// Recognised page names in the page registry.
///
/// Only these names are accepted by [`fetch_page_content`]; any other name
/// is rejected with [`PageQueryError::UnknownPage`].
pub const KNOWN_PAGES: &[&str] = &[
    "prd",
    "architecture",
    "plan",
    "strategy",
    "technical",
    "project",
    // Proposed specification delta inferred from runtime signals (issue #709).
    // Written by the IntentSpecInference gardening step as a *proposal* for a
    // human to confirm or correct — never auto-applied to the real spec pages.
    "spec-delta-proposal",
];

/// Errors that can occur during a page query.
#[derive(Debug, Error)]
pub enum PageQueryError {
    /// A database error from sqlx.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The caller requested a page name that is not in the registry.
    #[error(
        "unknown page '{0}'; known pages: prd, architecture, plan, strategy, technical, project, spec-delta-proposal"
    )]
    UnknownPage(String),
}

/// Fetch the current markdown content of a named page from `nexum.page_revisions`.
///
/// # Arguments
///
/// * `pool`      — the shared [`sqlx::PgPool`] from `sf-db`.
/// * `page_name` — a name from the page registry (e.g. `"prd"`).
///
/// # Returns
///
/// - `Ok(Some(markdown))` — the page exists; the most recent revision's
///   content is returned.
/// - `Ok(None)` — no revision exists in `nexum.page_revisions` yet for this
///   page name (the gardening loop has not yet produced a revision).
/// - `Err(PageQueryError::UnknownPage)` — `page_name` is not in the registry.
/// - `Err(PageQueryError::Database)` — a Postgres query failed.
///
/// # Implementation note
///
/// This function queries `nexum.page_revisions` by `page_name`, ordering by
/// `ingested_at DESC` and taking the most recent row.  The read path is
/// workspace-agnostic (no `workspace_id` filter) — the gardening loop is
/// the sole writer and the latest row always represents the current page state.
/// Decision recorded in issue #547 (Option A).
pub async fn fetch_page_content(
    pool: &PgPool,
    page_name: &str,
) -> Result<Option<String>, PageQueryError> {
    // Validate against the known registry first so callers get a clear error.
    if !KNOWN_PAGES.contains(&page_name) {
        return Err(PageQueryError::UnknownPage(page_name.to_string()));
    }

    // Single-table lookup: latest revision for this page name.
    let content: Option<String> = sqlx::query_scalar(
        "SELECT content \
         FROM nexum.page_revisions \
         WHERE page_name = $1 \
         ORDER BY ingested_at DESC \
         LIMIT 1",
    )
    .bind(page_name)
    .fetch_optional(pool)
    .await?;

    Ok(content)
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

    /// Integration test: fetch latest revision for a named page.
    ///
    /// Inserts two page_revisions rows for the same page_name; asserts that the
    /// query returns only the content from the later revision.
    ///
    /// Skipped unless `DATABASE_URL` is set with the nexum schema migrated.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum schema migrated"]
    async fn page_query_returns_latest_revision() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");

        // Use a workspace_id placeholder (the read path ignores it but the
        // table has a NOT NULL constraint on workspace_id).
        let workspace_id = uuid::Uuid::new_v4();

        // Insert revision 1 with 'v1 content' (older — will be shadowed).
        sqlx::query(
            "INSERT INTO nexum.page_revisions \
             (workspace_id, page_name, content, provenance, ingested_at) \
             VALUES ($1, 'prd', 'v1 content', 'test', now() - interval '1 second')",
        )
        .bind(workspace_id)
        .execute(&pool)
        .await
        .expect("revision 1 insert failed");

        // Insert revision 2 with 'v2 content' (newer — must be returned).
        sqlx::query(
            "INSERT INTO nexum.page_revisions \
             (workspace_id, page_name, content, provenance, ingested_at) \
             VALUES ($1, 'prd', 'v2 content', 'test', now())",
        )
        .bind(workspace_id)
        .execute(&pool)
        .await
        .expect("revision 2 insert failed");

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
            "v1 content must not appear in latest-revision result, got: {:?}",
            content
        );

        // Cleanup.
        sqlx::query(
            "DELETE FROM nexum.page_revisions \
             WHERE page_name = 'prd' AND workspace_id = $1",
        )
        .bind(workspace_id)
        .execute(&pool)
        .await
        .ok();
    }
}
