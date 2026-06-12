//! Page-revision write path — stub seam for the gardening loop write path.
//!
//! Defines [`insert_page_revision`], the single write entrypoint through which
//! the gardening loop engine (issue #491) persists computed page revisions to
//! the shared Postgres substrate. Nexum (issue #490) also calls this function
//! when updating a page during document ingestion.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Nexum — page-revision schema and write contract.
//! - `docs/prd.md` — gardening appliance page model.
//!
//! # Seam contract
//!
//! The caller provides:
//! - `pool`       — the shared [`sqlx::PgPool`] from `sf-db`.
//! - `page_name`  — the human-readable page identifier (e.g. `"company-background"`).
//! - `content`    — the rendered Markdown/plain-text content of the revision.
//! - `provenance` — a free-text provenance tag (e.g. a document URL or agent ID).
//!
//! The function returns `Ok(())` on success. In the stub phase it always
//! returns `Ok(())` without touching the database.
//!
//! # Implementation path (issues #490, #491)
//!
//! Issue #490 (seed document ingestion) and #491 (gardening loop engine) will
//! replace this stub with a real `INSERT INTO nexum.page_revisions` statement.
//! The table DDL will live in a migration added by one of those issues.
//!
//! Discovered integration risks (captured by issue #494 scout):
//!
//! - **Schema ownership**: `nexum.page_revisions` belongs to the nexum schema.
//!   The migration that creates it should live in `crates/nexum/migrations/`
//!   and be applied before either #490 or #491 write their first revision.
//! - **Workspace scoping**: every row will need a `workspace_id UUID NOT NULL`
//!   FK (per the workspace_id threading migration `0003_workspace_id_threading.sql`).
//!   Issues #490 and #491 must pass the workspace ID through the call site.
//!   This stub omits it intentionally to avoid breaking callers before the
//!   threading migration is applied.
//! - **Idempotency**: the loop engine calls this function on every gardening
//!   cycle. The real implementation should use `ON CONFLICT DO UPDATE` so that
//!   re-running a gardening step is safe.

/// Error type for page-revision write operations.
///
/// Extended by issues #490 and #491 to cover database constraint violations
/// and schema-not-found errors.
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
/// # Arguments
///
/// * `_pool`       — shared [`sqlx::PgPool`] (unused in the stub).
/// * `_page_name`  — human-readable page identifier.
/// * `_content`    — rendered page content (Markdown or plain text).
/// * `_provenance` — free-text provenance tag (agent ID, document URL, etc.).
///
/// # Errors
///
/// Always returns `Ok(())` in this stub. The real implementation (issues #490
/// and #491) will return [`PageRevisionError::Database`] on Postgres errors and
/// [`PageRevisionError::TableMissing`] when the migration has not been applied.
///
/// # Stub behaviour
///
/// This function is a deliberate no-op. It is here to:
/// 1. Let `crates/nexum` and the loop engine crate import a stable symbol.
/// 2. Confirm the call-site signature before the real INSERT is written.
/// 3. Allow `cargo build --workspace` to pass on the phase branch from day one.
///
/// Replace with a real `sqlx::query!` INSERT in issues #490 / #491.
pub async fn insert_page_revision(
    _pool: &sqlx::PgPool,
    _page_name: &str,
    _content: &str,
    _provenance: &str,
) -> Result<(), PageRevisionError> {
    // STUB — no-op. See module doc for implementation path.
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify the stub compiles and returns Ok without a live database.
    ///
    /// The real integration test (written in issue #490 / #491) will require
    /// `DATABASE_URL` and a migration-applied schema.
    #[tokio::test]
    async fn insert_page_revision_stub_returns_ok() {
        // Build a minimal disconnected pool — the stub never queries it.
        // We pass a dummy URL; the pool is lazy and will not attempt to connect
        // until a query is issued.
        let pool = sqlx::PgPool::connect_lazy("postgres://localhost/stub_db_never_connects")
            .expect("lazy connect should not fail");

        let result = insert_page_revision(&pool, "company-background", "# stub", "scout-494").await;
        assert!(result.is_ok());
    }
}
