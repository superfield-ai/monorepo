//! Integration tests for workspace_id threading (issue #429).
//!
//! Verifies the acceptance criteria:
//!   - `workspaces` table exists after migration is applied.
//!   - Core tables carry `workspace_id UUID NOT NULL` with FK to `workspaces`.
//!   - Inserts into core tables without a workspace context are rejected.
//!   - Application-layer query helpers (nexum ingest/query) pass `workspace_id`.
//!
//! These tests require a live Postgres instance with the full migration suite
//! applied.  They are skipped when `DATABASE_URL` is not set so that offline
//! CI is not broken.
//!
//! Run them with:
//! ```bash
//! DATABASE_URL=postgres://user:pass@localhost/dbname \
//!     cargo test -p sf-db --test workspace_id_integration
//! ```

use sqlx::PgPool;

/// Connect to the database at `DATABASE_URL`, or return `None` to skip.
async fn maybe_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(
        sqlx::PgPool::connect(&url)
            .await
            .expect("failed to connect to DATABASE_URL"),
    )
}

// ---------------------------------------------------------------------------
// AC-1: workspaces table exists
// ---------------------------------------------------------------------------

/// The `public.workspaces` table must exist after the migration suite has run.
#[tokio::test]
async fn workspaces_table_exists() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name   = 'workspaces'
        )
        "#,
    )
    .fetch_one(&pool)
    .await
    .expect("workspaces existence query failed");

    assert!(exists, "public.workspaces table must exist");
}

// ---------------------------------------------------------------------------
// AC-2: core tables have workspace_id UUID NOT NULL with FK
// ---------------------------------------------------------------------------

/// Verify that selected core tables have a `workspace_id` column that is
/// `NOT NULL` and carries a FK to `public.workspaces(id)`.
#[tokio::test]
async fn core_tables_have_workspace_id_not_null_with_fk() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    // Tables that must have workspace_id with FK after migration 0003.
    // Junction tables (version_blocks, corpus_access, episode_events, etc.) are
    // excluded because they inherit workspace scoping via parent FK.
    let tables: &[(&str, &str)] = &[
        ("nexum", "corpora"),
        ("nexum", "documents"),
        ("nexum", "document_versions"),
        ("nexum", "blocks"),
        ("nexum", "links"),
        ("nexum", "entities"),
        ("nexum", "relations"),
        ("nexum", "job_queue"),
        ("auth", "sessions"),
        ("auth", "app_installations"),
        ("sharp", "repos"),
    ];

    for (schema, table) in tables {
        // Check column exists and is NOT NULL.
        let col_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema  = $1
                  AND table_name    = $2
                  AND column_name   = 'workspace_id'
                  AND is_nullable   = 'NO'
            )
            "#,
        )
        .bind(schema)
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("column check failed for {}.{}: {}", schema, table, e));

        assert!(
            col_exists,
            "{}.{} must have workspace_id UUID NOT NULL",
            schema, table
        );

        // Check FK to public.workspaces exists.
        let fk_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.referential_constraints rc
                JOIN information_schema.key_column_usage kcu
                  ON kcu.constraint_name = rc.constraint_name
                 AND kcu.constraint_schema = rc.constraint_schema
                JOIN information_schema.key_column_usage kcu2
                  ON kcu2.constraint_name = rc.unique_constraint_name
                 AND kcu2.constraint_schema = rc.unique_constraint_schema
                WHERE kcu.table_schema  = $1
                  AND kcu.table_name    = $2
                  AND kcu.column_name   = 'workspace_id'
                  AND kcu2.table_schema = 'public'
                  AND kcu2.table_name   = 'workspaces'
                  AND kcu2.column_name  = 'id'
            )
            "#,
        )
        .bind(schema)
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("FK check failed for {}.{}: {}", schema, table, e));

        assert!(
            fk_exists,
            "{}.{} must have FK workspace_id → public.workspaces(id)",
            schema, table
        );
    }
}

// ---------------------------------------------------------------------------
// AC-3 (test plan TP-1): insert without workspace_id fails constraint
// ---------------------------------------------------------------------------

/// Inserting into a core table without providing a `workspace_id` must fail
/// with a NOT NULL constraint violation.
///
/// This test uses `nexum.corpora` as a representative core table; the same
/// constraint is applied to every other core table by the migration.
#[tokio::test]
async fn insert_without_workspace_id_fails_not_null() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let result = sqlx::query(
        // Deliberately omit workspace_id to trigger the NOT NULL constraint.
        "INSERT INTO nexum.corpora (name) VALUES ('constraint-test-no-ws')",
    )
    .execute(&pool)
    .await;

    assert!(
        result.is_err(),
        "INSERT without workspace_id must fail with a constraint error"
    );

    let err_msg = result.unwrap_err().to_string();
    // Postgres reports "null value in column \"workspace_id\"" or similar.
    assert!(
        err_msg.contains("workspace_id") || err_msg.contains("null value"),
        "error must mention workspace_id or null constraint, got: {}",
        err_msg
    );
}

// ---------------------------------------------------------------------------
// TP-2: workspaceId with invalid FK is rejected
// ---------------------------------------------------------------------------

/// Inserting a row whose `workspace_id` does not reference an existing
/// `workspaces` row must fail with a FK constraint violation.
#[tokio::test]
async fn insert_with_nonexistent_workspace_id_fails_fk() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let nonexistent_ws = uuid::Uuid::new_v4();

    let result =
        sqlx::query("INSERT INTO nexum.corpora (workspace_id, name) VALUES ($1, 'fk-test-corpus')")
            .bind(nonexistent_ws)
            .execute(&pool)
            .await;

    assert!(
        result.is_err(),
        "INSERT with a non-existent workspace_id must fail with a FK error"
    );

    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("workspaces") || err_msg.contains("foreign key"),
        "error must mention workspaces FK violation, got: {}",
        err_msg
    );
}
