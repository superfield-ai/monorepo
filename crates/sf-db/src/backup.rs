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
