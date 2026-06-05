//! Integration tests for Postgres streaming replication and recovery drill.
//!
//! These tests require the replication stack started by:
//!
//! ```bash
//! docker compose -f docker-compose.replication.yml up -d
//! # Wait for the standby to finish pg_basebackup bootstrapping, then:
//! PRIMARY_URL=postgres://postgres:postgres@localhost:5440/superfield \
//! STANDBY_URL=postgres://postgres:postgres@localhost:5441/superfield \
//!     cargo test -p sf-db --test replication_integration
//! ```
//!
//! When neither `PRIMARY_URL` nor `STANDBY_URL` are set the tests are
//! skipped so offline CI is not broken.
//!
//! # What is verified
//!
//! 1. **Write-to-primary → read-from-standby** — confirms WAL is being
//!    streamed and applied on the standby (replication lag check).
//! 2. **pg_basebackup args helper** — unit-level assertion that the helper
//!    returns the expected CLI argument vector.
//! 3. **WAL archive command template** — verifies the `cp %p <dir>/%f` form.
//! 4. **Recovery drill (backup round-trip)** — records a synthetic
//!    [`BackupEvent`] into `substrate.backups` on the primary and verifies
//!    `PgBackup::latest()` returns it correctly, simulating the event the
//!    CronJob runner would emit after `pg_basebackup` completes.
//!
//! See `docs/architecture.md` §Substrate Reliability for the full runbook
//! and `docker-compose.replication.yml` for the local stack definition.

use std::time::SystemTime;

use sf_db::backup::{
    BackupEvent, BackupOutcome, NoopSubstrateBackup, PgBackup, SubstrateBackup,
    pg_basebackup_args, wal_archive_command_template,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Returns a pool for the given URL, or `None` if the env var is unset.
async fn pool_for_url(env_var: &str) -> Option<sqlx::PgPool> {
    let url = std::env::var(env_var).ok()?;
    Some(
        sqlx::PgPool::connect(&url)
            .await
            .unwrap_or_else(|e| panic!("cannot connect to {env_var}={url}: {e}")),
    )
}

async fn setup_substrate(pool: &sqlx::PgPool) {
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
    .expect("setup_substrate: failed to create substrate.backups");
}

async fn teardown_substrate(pool: &sqlx::PgPool) {
    sqlx::query("DROP TABLE IF EXISTS substrate.backups")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DROP SCHEMA IF EXISTS substrate")
        .execute(pool)
        .await
        .ok();
}

// ---------------------------------------------------------------------------
// Unit-level helper tests (no live DB required)
// ---------------------------------------------------------------------------

/// [`pg_basebackup_args`] returns the expected CLI argument vector.
#[test]
fn pg_basebackup_args_returns_correct_vector() {
    let args = pg_basebackup_args("/tmp/backup", "pg-primary", 5432);
    assert_eq!(
        args,
        vec![
            "-D",
            "/tmp/backup",
            "-h",
            "pg-primary",
            "-p",
            "5432",
            "-Ft",
            "-z",
            "--wal-method=stream",
        ]
    );
}

/// [`wal_archive_command_template`] returns the expected `cp` command.
#[test]
fn wal_archive_command_template_correct() {
    let cmd = wal_archive_command_template("/var/lib/postgresql/wal_archive");
    assert_eq!(cmd, "cp %p /var/lib/postgresql/wal_archive/%f");
}

/// [`NoopSubstrateBackup`] satisfies the trait with zero-cost stubs.
#[tokio::test]
async fn noop_backup_satisfies_seam() {
    let b = NoopSubstrateBackup;
    let event = BackupEvent {
        completed_at: SystemTime::now(),
        location: "gs://sf-backups-test/drill/base.tar.gz".to_string(),
        outcome: BackupOutcome::Success,
        start_lsn: Some("0/2000000".to_string()),
    };
    assert!(b.record(event).await.is_ok());
    assert!(b.latest().await.unwrap().is_none());
}

// ---------------------------------------------------------------------------
// Live-database tests (require PRIMARY_URL)
// ---------------------------------------------------------------------------

/// Recovery drill: record a [`BackupEvent`] via [`PgBackup`] on the primary
/// and verify `latest()` returns the correct event.
///
/// This simulates the CronJob runner calling `PgBackup::record` after
/// `pg_basebackup` completes.
#[tokio::test]
async fn recovery_drill_backup_event_round_trip() {
    let pool = match pool_for_url("PRIMARY_URL").await {
        Some(p) => p,
        None => {
            eprintln!("skipping recovery_drill: PRIMARY_URL not set");
            return;
        }
    };

    setup_substrate(&pool).await;

    let backup = PgBackup::new(pool.clone(), "/tmp/sf-recovery-drill");

    let event = BackupEvent {
        completed_at: SystemTime::UNIX_EPOCH
            + std::time::Duration::from_secs(1_750_100_000),
        location: "gs://sf-backups/dev/2026-06-05/base.tar.gz".to_string(),
        outcome: BackupOutcome::Success,
        start_lsn: Some("0/3A000000".to_string()),
    };

    backup
        .record(event.clone())
        .await
        .expect("record should succeed on primary");

    let latest = backup
        .latest()
        .await
        .expect("latest should succeed")
        .expect("latest should return Some after record");

    assert_eq!(latest.location, event.location);
    assert_eq!(latest.outcome, BackupOutcome::Success);
    assert_eq!(latest.start_lsn, event.start_lsn);

    teardown_substrate(&pool).await;
}

// ---------------------------------------------------------------------------
// Streaming replication: write to primary, read from standby
// ---------------------------------------------------------------------------

/// Confirms WAL is streamed: a table written on the primary becomes visible
/// on the hot standby within a short polling window.
///
/// Requires both `PRIMARY_URL` and `STANDBY_URL` to be set.
#[tokio::test]
async fn write_primary_visible_on_standby() {
    let primary = match pool_for_url("PRIMARY_URL").await {
        Some(p) => p,
        None => {
            eprintln!("skipping write_primary_visible_on_standby: PRIMARY_URL not set");
            return;
        }
    };
    let standby = match pool_for_url("STANDBY_URL").await {
        Some(p) => p,
        None => {
            eprintln!("skipping write_primary_visible_on_standby: STANDBY_URL not set");
            return;
        }
    };

    // Create a canary table on the primary.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS replication_canary (
            id   SERIAL PRIMARY KEY,
            val  TEXT NOT NULL,
            ts   TIMESTAMPTZ DEFAULT now()
        )
        "#,
    )
    .execute(&primary)
    .await
    .expect("create canary table on primary");

    // Insert a sentinel row.
    let sentinel = format!("repl-drill-{}", SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs());

    sqlx::query("INSERT INTO replication_canary (val) VALUES ($1)")
        .bind(&sentinel)
        .execute(&primary)
        .await
        .expect("insert sentinel on primary");

    // Poll the standby for up to 30 seconds (≤ standby lag target).
    let mut found = false;
    for _ in 0..30 {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT val FROM replication_canary WHERE val = $1 LIMIT 1",
        )
        .bind(&sentinel)
        .fetch_optional(&standby)
        .await
        .unwrap_or(None);

        if row.is_some() {
            found = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }

    // Cleanup on primary — the DROP will also replicate.
    sqlx::query("DROP TABLE IF EXISTS replication_canary")
        .execute(&primary)
        .await
        .ok();

    assert!(
        found,
        "sentinel row written on primary was not visible on standby within 30 s; \
         check streaming replication health (pg_stat_replication)"
    );
}
