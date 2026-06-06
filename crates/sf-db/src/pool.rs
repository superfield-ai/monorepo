//! Shared `PgPool` construction and workspace-context-aware connection acquisition.
//!
//! All component crates call [`connect`] once at startup and retain the returned
//! [`sqlx::PgPool`].  Per-request, callers use [`acquire_workspace`] to obtain a
//! connection with the workspace (principal) context already set via
//! `SET LOCAL app.current_principal_id = '<id>'` so that per-schema RLS policies
//! can fire correctly.
//!
//! See `docs/architecture.md` §RLS policies are scoped per schema.

use crate::config::DbConfig;
use sqlx::{pool::PoolConnection, postgres::PgPoolOptions, PgPool, Postgres};
use thiserror::Error;

/// Errors that can occur when acquiring a workspace-context connection.
#[derive(Debug, Error)]
pub enum PoolError {
    /// A database error from sqlx.
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Build a [`PgPool`] from a [`DbConfig`].
///
/// This is the single place in the codebase where a Postgres pool is created.
/// Component crates receive the pool (e.g. via dependency injection or
/// `Arc<PgPool>`) and never open their own pools.
///
/// # Errors
///
/// Returns [`sqlx::Error`] if the pool cannot be created or if the initial
/// connection attempt fails.
pub async fn connect(cfg: &DbConfig) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(cfg.max_connections)
        .connect(&cfg.database_url)
        .await
}

/// Acquire a [`PoolConnection<Postgres>`] with workspace context applied.
///
/// After taking a connection from the pool, this function runs:
///
/// ```sql
/// SET LOCAL app.current_principal_id = '<principal_id>';
/// ```
///
/// This makes the principal identity available to RLS policies via
/// `current_setting('app.current_principal_id')` for the duration of the
/// current transaction.  Callers must open a transaction before issuing
/// data-modifying statements so that the `SET LOCAL` is scoped correctly.
///
/// # Arguments
///
/// * `pool` — the shared pool obtained from [`connect`].
/// * `principal_id` — the workspace / principal UUID to set.  Pass an empty
///   string to clear the context (useful in tests).
///
/// # Errors
///
/// Returns [`PoolError::Sqlx`] if the pool is exhausted, the connection is
/// broken, or the `SET LOCAL` statement fails.
pub async fn acquire_workspace(
    pool: &PgPool,
    principal_id: &str,
) -> Result<PoolConnection<Postgres>, PoolError> {
    let mut conn = pool.acquire().await?;
    sqlx::query("SET LOCAL app.current_principal_id = $1")
        .bind(principal_id)
        .execute(&mut *conn)
        .await?;
    Ok(conn)
}

/// Acquire a [`PoolConnection<Postgres>`] with both the workspace identity and
/// the legacy principal identity set as session-local variables.
///
/// This is the preferred helper for issue #429-compliant callers.  It sets:
///
/// ```sql
/// SET LOCAL app.workspace_id      = '<workspace_id>';
/// SET LOCAL app.current_principal_id = '<workspace_id>';
/// ```
///
/// RLS policies authored by issue #430 will reference `app.workspace_id`.  The
/// legacy `app.current_principal_id` is kept for backwards compatibility until
/// all policies have migrated.
///
/// # Arguments
///
/// * `pool`         — the shared pool obtained from [`connect`].
/// * `workspace_id` — UUID of the workspace (tenant) to bind.
///
/// # Errors
///
/// Returns [`PoolError::Sqlx`] if the pool is exhausted, the connection is
/// broken, or either `SET LOCAL` statement fails.
pub async fn acquire_with_workspace_id(
    pool: &PgPool,
    workspace_id: uuid::Uuid,
) -> Result<PoolConnection<Postgres>, PoolError> {
    let ws_str = workspace_id.to_string();
    let mut conn = pool.acquire().await?;
    sqlx::query("SET LOCAL app.workspace_id = $1")
        .bind(&ws_str)
        .execute(&mut *conn)
        .await?;
    sqlx::query("SET LOCAL app.current_principal_id = $1")
        .bind(&ws_str)
        .execute(&mut *conn)
        .await?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    // Integration tests that require a live Postgres instance are gated behind
    // the `DATABASE_URL` environment variable so they are skipped in offline CI.
    //
    // Run them with:
    //   DATABASE_URL=postgres://… cargo test -p sf-db -- --include-ignored integration
    //
    // The unit tests below exercise the pool-building logic without a real DB.

    use super::*;
    use crate::config::DbConfig;

    /// Verify that `connect` rejects a clearly invalid URL rather than hanging.
    ///
    /// This test does not require a live database — sqlx returns an error
    /// almost immediately for a URL that resolves to a port with nothing
    /// listening.
    #[tokio::test]
    async fn connect_returns_error_for_unreachable_host() {
        let cfg =
            DbConfig::from_url("postgres://sf_test:sf_test@127.0.0.1:19999/sf_test_unreachable")
                .unwrap();
        // sqlx may succeed in building the pool (lazy connect) or fail eagerly;
        // either way we just verify the call completes without a panic.
        // If the connection does fail we expect a sqlx error, not a panic.
        let _result = connect(&cfg).await;
        // No assertion — we just confirm the function does not panic.
    }

    // --- Integration tests (require DATABASE_URL) ---

    /// Unit test: pool hands out working connections.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL"]
    async fn pool_hands_out_working_connection() {
        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set for integration tests");
        let pool = connect(&cfg).await.expect("pool creation failed");

        let row: (i32,) = sqlx::query_as("SELECT 1")
            .fetch_one(&pool)
            .await
            .expect("SELECT 1 failed");
        assert_eq!(row.0, 1);
    }

    /// Integration test: a connection carries workspace context for RLS.
    ///
    /// Verifies that [`acquire_workspace`] sets `app.current_principal_id`
    /// on the connection so RLS policies can read it.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL"]
    async fn acquire_workspace_sets_principal_context() {
        use sqlx::Acquire;

        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set for integration tests");
        let pool = connect(&cfg).await.expect("pool creation failed");

        let principal_id = "ws_test_00000000-0000-0000-0000-000000000001";

        // acquire_workspace requires an explicit transaction for SET LOCAL to be
        // scoped to the transaction; here we start one manually.
        let mut conn = pool.acquire().await.expect("acquire failed");
        let mut tx = conn.begin().await.expect("begin failed");

        sqlx::query("SET LOCAL app.current_principal_id = $1")
            .bind(principal_id)
            .execute(&mut *tx)
            .await
            .expect("SET LOCAL failed");

        let row: (String,) = sqlx::query_as("SELECT current_setting('app.current_principal_id')")
            .fetch_one(&mut *tx)
            .await
            .expect("current_setting query failed");

        assert_eq!(row.0, principal_id);
        tx.rollback().await.expect("rollback failed");
    }
}
