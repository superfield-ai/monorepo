//! Substrate backup and recovery seam.
//!
//! Defines the [`SubstrateBackup`] trait, which component crates and operations
//! tooling implement to record and query backup events against the shared
//! Postgres instance.
//!
//! # Recovery Objectives (issue #385)
//!
//! | Metric                     | Target              | Notes                                          |
//! | -------------------------- | ------------------- | ---------------------------------------------- |
//! | **RPO** (Recovery Point)   | ≤ 5 minutes         | WAL archiving interval                         |
//! | **RTO** (Recovery Time)    | ≤ 15 minutes        | Restore from base backup + replay WAL segments |
//! | **Standby replication lag** | ≤ 30 seconds       | Streaming replication to one hot standby       |
//! | **Base backup frequency**  | Daily               | `pg_basebackup` snapshot + continuous WAL arch |
//!
//! # Implementation path
//!
//! The production backup stack is:
//!
//! 1. **Streaming replication** — one hot standby via `pg_basebackup` + `recovery.conf`
//!    (or `postgresql.conf` `primary_conninfo` on Postgres 12+). The standby is
//!    read-only and replays WAL in near-real-time.
//! 2. **WAL archiving** — `archive_mode = on`, `archive_command` ships WAL
//!    segments to durable object storage (e.g. GCS/S3) so point-in-time recovery
//!    is possible up to the last archived segment.
//! 3. **Base backup** — a daily `pg_basebackup` against the primary writes a
//!    consistent filesystem snapshot alongside the WAL archive.
//! 4. **Restore procedure** — documented in `docs/architecture.md`
//!    §Substrate Reliability.
//!
//! # Seam contract
//!
//! Callers (operations tooling, CI) implement [`SubstrateBackup`] to record
//! backup completion events. The default no-op stub
//! ([`NoopSubstrateBackup`]) satisfies the seam in tests and in components
//! that have not yet wired a real implementation.
//!
//! See `docs/architecture.md` §Substrate Reliability for the authoritative
//! design.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::SystemTime;

/// The outcome of a completed backup operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupOutcome {
    /// The backup completed successfully and data is intact.
    Success,
    /// The backup was attempted but failed; the error message is included.
    Failure(String),
}

/// A completed backup event to be recorded.
#[derive(Debug, Clone)]
pub struct BackupEvent {
    /// When the backup finished.
    pub completed_at: SystemTime,
    /// Base location of the backup artifact (e.g. a GCS path or filesystem path).
    pub location: String,
    /// Whether the backup succeeded or failed.
    pub outcome: BackupOutcome,
    /// Postgres LSN (Log Sequence Number) at the point the backup started,
    /// expressed as `XY/ABCDEF01`. Used to verify WAL continuity.
    pub start_lsn: Option<String>,
}

/// Boxed future alias used by the [`SubstrateBackup`] trait methods.
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Seam interface for recording and querying substrate backup events.
///
/// Operations tooling provides a real implementation that writes to the
/// `episodes` schema (or a dedicated `substrate.backups` table once that
/// schema is defined). Tests and components that do not own backup logic
/// use [`NoopSubstrateBackup`].
///
/// # Required interface
///
/// - [`record`] — called by the backup runner when a base backup or WAL-archive
///   event completes; persists the event.
/// - [`latest`] — returns the most recent [`BackupEvent`] if one has been
///   recorded; used by health checks to verify the backup SLA is met.
pub trait SubstrateBackup: Send + Sync {
    /// Record a completed backup event.
    ///
    /// # Errors
    ///
    /// Returns [`BackupError`] if the event cannot be persisted (e.g. the
    /// database is unreachable or the target table does not exist yet).
    fn record(&self, event: BackupEvent) -> BoxFuture<'_, Result<(), BackupError>>;

    /// Return the most recent recorded backup event, if any.
    ///
    /// Returns `Ok(None)` when no backup has been recorded yet.
    ///
    /// # Errors
    ///
    /// Returns [`BackupError`] if the query fails.
    fn latest(&self) -> BoxFuture<'_, Result<Option<BackupEvent>, BackupError>>;
}

/// Error type for [`SubstrateBackup`] operations.
#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    /// A database error from sqlx.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The backup subsystem is not yet configured (no target table).
    #[error("backup subsystem not configured: {0}")]
    NotConfigured(String),
}

// ---------------------------------------------------------------------------
// PgBackup — real Postgres-backed implementation
// ---------------------------------------------------------------------------

/// Postgres-backed implementation of [`SubstrateBackup`].
///
/// Persists backup events to the `substrate.backups` table created by
/// migration `0002_substrate_backups.sql`. Requires the `substrate` schema
/// and the `backups` table to already exist (apply the migration first).
///
/// ```sql
/// CREATE SCHEMA IF NOT EXISTS substrate;
/// CREATE TABLE IF NOT EXISTS substrate.backups (
///     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
///     completed_at TIMESTAMPTZ NOT NULL,
///     location     TEXT NOT NULL,
///     outcome      TEXT NOT NULL,
///     start_lsn    TEXT
/// );
/// ```
pub struct PgBackup {
    pool: sqlx::PgPool,
    backup_dir: PathBuf,
}

impl PgBackup {
    /// Create a new [`PgBackup`] backed by `pool`, storing artifacts under
    /// `backup_dir`.
    pub fn new(pool: sqlx::PgPool, backup_dir: impl Into<PathBuf>) -> Self {
        Self {
            pool,
            backup_dir: backup_dir.into(),
        }
    }

    /// Return the configured backup directory (e.g. for passing to
    /// `pg_basebackup`).
    pub fn backup_dir(&self) -> &PathBuf {
        &self.backup_dir
    }
}

impl SubstrateBackup for PgBackup {
    fn record(&self, event: BackupEvent) -> BoxFuture<'_, Result<(), BackupError>> {
        Box::pin(async move {
            let completed_at: chrono::DateTime<chrono::Utc> = event.completed_at.into();
            let outcome_str = match &event.outcome {
                BackupOutcome::Success => "success".to_string(),
                BackupOutcome::Failure(msg) => format!("failure:{}", msg),
            };

            sqlx::query(
                r#"
                INSERT INTO substrate.backups (completed_at, location, outcome, start_lsn)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT DO NOTHING
                "#,
            )
            .bind(completed_at)
            .bind(&event.location)
            .bind(&outcome_str)
            .bind(&event.start_lsn)
            .execute(&self.pool)
            .await
            .map_err(|e| match &e {
                sqlx::Error::Database(db_err) => {
                    // "42P01" is the SQLSTATE for "undefined_table".
                    if db_err.code().as_deref() == Some("42P01") {
                        BackupError::NotConfigured(format!(
                            "substrate.backups table does not exist: {}",
                            db_err.message()
                        ))
                    } else {
                        BackupError::Database(e)
                    }
                }
                _ => BackupError::Database(e),
            })?;

            Ok(())
        })
    }

    fn latest(&self) -> BoxFuture<'_, Result<Option<BackupEvent>, BackupError>> {
        Box::pin(async move {
            let row = sqlx::query_as::<_, BackupRow>(
                r#"
                SELECT completed_at, location, outcome, start_lsn
                FROM substrate.backups
                ORDER BY completed_at DESC
                LIMIT 1
                "#,
            )
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| match &e {
                sqlx::Error::Database(db_err) => {
                    if db_err.code().as_deref() == Some("42P01") {
                        BackupError::NotConfigured(format!(
                            "substrate.backups table does not exist: {}",
                            db_err.message()
                        ))
                    } else {
                        BackupError::Database(e)
                    }
                }
                _ => BackupError::Database(e),
            })?;

            Ok(row.map(|r| {
                let outcome = if r.outcome == "success" {
                    BackupOutcome::Success
                } else {
                    let msg = r.outcome.strip_prefix("failure:").unwrap_or(&r.outcome);
                    BackupOutcome::Failure(msg.to_string())
                };
                BackupEvent {
                    completed_at: r.completed_at.into(),
                    location: r.location,
                    outcome,
                    start_lsn: r.start_lsn,
                }
            }))
        })
    }
}

/// Internal row type for fetching from `substrate.backups`.
#[derive(sqlx::FromRow)]
struct BackupRow {
    completed_at: chrono::DateTime<chrono::Utc>,
    location: String,
    outcome: String,
    start_lsn: Option<String>,
}

// ---------------------------------------------------------------------------
// WAL archive and pg_basebackup helpers
// ---------------------------------------------------------------------------

/// Return the standard `archive_command` template for a WAL archive directory.
///
/// The returned string uses the Postgres `%p` (WAL file path) and `%f`
/// (WAL file name) substitution tokens:
///
/// ```text
/// cp %p <archive_dir>/%f
/// ```
///
/// This is suitable for setting `archive_command` in `postgresql.conf`.
/// For production use, replace `cp` with a command that copies to durable
/// object storage (e.g. `gsutil cp %p gs://sf-wal-archive/<env>/%f`).
pub fn wal_archive_command_template(archive_dir: &str) -> String {
    format!("cp %p {archive_dir}/%f")
}

/// Return arguments for a `pg_basebackup` invocation that writes a tar+gzip
/// backup with WAL streamed in parallel.
///
/// Equivalent to:
/// ```text
/// pg_basebackup -D <target_dir> -h <host> -p <port> -Ft -z --wal-method=stream
/// ```
///
/// # Arguments
///
/// * `target_dir` — local directory to write the backup into.
/// * `host` — Postgres hostname or socket directory.
/// * `port` — Postgres port number.
pub fn pg_basebackup_args(target_dir: &str, host: &str, port: u16) -> Vec<String> {
    vec![
        "-D".to_string(),
        target_dir.to_string(),
        "-h".to_string(),
        host.to_string(),
        "-p".to_string(),
        port.to_string(),
        "-Ft".to_string(),
        "-z".to_string(),
        "--wal-method=stream".to_string(),
    ]
}

// ---------------------------------------------------------------------------
// No-op implementation
// ---------------------------------------------------------------------------

/// No-op implementation of [`SubstrateBackup`] for tests and stub wiring.
///
/// [`record`] always returns `Ok(())`; [`latest`] always returns `Ok(None)`.
/// This satisfies the seam contract without requiring a live database or a
/// migrations-applied `substrate.backups` table.
pub struct NoopSubstrateBackup;

impl SubstrateBackup for NoopSubstrateBackup {
    fn record(&self, _event: BackupEvent) -> BoxFuture<'_, Result<(), BackupError>> {
        Box::pin(async { Ok(()) })
    }

    fn latest(&self) -> BoxFuture<'_, Result<Option<BackupEvent>, BackupError>> {
        Box::pin(async { Ok(None) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn noop_record_returns_ok() {
        let b = NoopSubstrateBackup;
        let event = BackupEvent {
            completed_at: SystemTime::now(),
            location: "gs://sf-backups/2026-06-01/base.tar.gz".to_string(),
            outcome: BackupOutcome::Success,
            start_lsn: Some("0/1A000000".to_string()),
        };
        assert!(b.record(event).await.is_ok());
    }

    #[tokio::test]
    async fn noop_latest_returns_none() {
        let b = NoopSubstrateBackup;
        let result = b.latest().await.unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn backup_outcome_equality() {
        assert_eq!(BackupOutcome::Success, BackupOutcome::Success);
        assert_eq!(
            BackupOutcome::Failure("disk full".to_string()),
            BackupOutcome::Failure("disk full".to_string())
        );
        assert_ne!(
            BackupOutcome::Success,
            BackupOutcome::Failure("".to_string())
        );
    }
}
