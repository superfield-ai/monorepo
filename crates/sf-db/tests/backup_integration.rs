//! Integration tests for [`PgBackup`].
//!
//! These tests require a live Postgres instance. They are skipped when the
//! `DATABASE_URL` environment variable is not set so that offline CI is not
//! broken.
//!
//! Run them with:
//! ```bash
//! DATABASE_URL=postgres://user:pass@localhost/dbname \
//!     cargo test -p sf-db --test backup_integration
//! ```

use std::time::SystemTime;

use sf_db::backup::{BackupEvent, BackupOutcome, PgBackup, SubstrateBackup};

/// Helper: create a `PgPool` from `DATABASE_URL` or skip the test.
async fn pool_or_skip() -> Option<sqlx::PgPool> {
    let url = match std::env::var("DATABASE_URL") {
        Ok(u) => u,
        Err(_) => return None,
    };
    Some(
        sqlx::PgPool::connect(&url)
            .await
            .expect("cannot connect to DATABASE_URL"),
    )
}

/// Apply the substrate schema and backups table.
async fn setup(pool: &sqlx::PgPool) {
    sqlx::query(
        r#"
        CREATE SCHEMA IF NOT EXISTS substrate;
        CREATE TABLE IF NOT EXISTS substrate.backups (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            completed_at TIMESTAMPTZ NOT NULL,
            location     TEXT NOT NULL,
            outcome      TEXT NOT NULL,
            start_lsn    TEXT
        )
        "#,
    )
    .execute(pool)
    .await
    .expect("setup: failed to create substrate.backups");
}

/// Remove the table and schema created by `setup`.
async fn teardown(pool: &sqlx::PgPool) {
    sqlx::query("DROP TABLE IF EXISTS substrate.backups")
        .execute(pool)
        .await
        .expect("teardown: failed to drop substrate.backups");
    sqlx::query("DROP SCHEMA IF EXISTS substrate")
        .execute(pool)
        .await
        .expect("teardown: failed to drop substrate schema");
}

/// Round-trip: record a `BackupEvent` and verify `latest()` returns it.
#[tokio::test]
async fn record_and_latest_round_trip() {
    let pool = match pool_or_skip().await {
        Some(p) => p,
        None => {
            eprintln!("skipping backup_integration: DATABASE_URL not set");
            return;
        }
    };

    setup(&pool).await;

    let backup = PgBackup::new(pool.clone(), "/tmp/sf-backups-test");

    let event = BackupEvent {
        completed_at: SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_750_000_000),
        location: "gs://sf-backups-test/2026-06-01/base.tar.gz".to_string(),
        outcome: BackupOutcome::Success,
        start_lsn: Some("0/1A000000".to_string()),
    };

    backup
        .record(event.clone())
        .await
        .expect("record should succeed");

    let latest = backup
        .latest()
        .await
        .expect("latest should succeed")
        .expect("latest should return Some after record");

    assert_eq!(latest.location, event.location);
    assert_eq!(latest.outcome, BackupOutcome::Success);
    assert_eq!(latest.start_lsn, event.start_lsn);

    teardown(&pool).await;
}

/// Verify that a failure outcome round-trips correctly.
#[tokio::test]
async fn failure_outcome_round_trips() {
    let pool = match pool_or_skip().await {
        Some(p) => p,
        None => {
            eprintln!("skipping backup_integration: DATABASE_URL not set");
            return;
        }
    };

    setup(&pool).await;

    let backup = PgBackup::new(pool.clone(), "/tmp/sf-backups-test");

    let event = BackupEvent {
        completed_at: SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_750_000_100),
        location: "gs://sf-backups-test/2026-06-02/base.tar.gz".to_string(),
        outcome: BackupOutcome::Failure("disk full".to_string()),
        start_lsn: None,
    };

    backup
        .record(event.clone())
        .await
        .expect("record should succeed");

    let latest = backup
        .latest()
        .await
        .expect("latest should succeed")
        .expect("latest should return Some");

    assert_eq!(
        latest.outcome,
        BackupOutcome::Failure("disk full".to_string())
    );
    assert!(latest.start_lsn.is_none());

    teardown(&pool).await;
}

/// `latest()` returns `None` when no backups have been recorded.
#[tokio::test]
async fn latest_returns_none_when_empty() {
    let pool = match pool_or_skip().await {
        Some(p) => p,
        None => {
            eprintln!("skipping backup_integration: DATABASE_URL not set");
            return;
        }
    };

    setup(&pool).await;

    let backup = PgBackup::new(pool.clone(), "/tmp/sf-backups-test");
    let latest = backup
        .latest()
        .await
        .expect("latest should succeed on empty table");
    assert!(latest.is_none(), "expected None for empty table");

    teardown(&pool).await;
}
