//! Shared Postgres connection pool and typed config for Superfield component crates.
//!
//! All component crates (Sharp, Nexum, auth, etc.) acquire database connections
//! through this crate. One pool, one Postgres instance — components do not
//! provision their own database access.
//!
//! # Architecture
//!
//! - [`DbConfig`]: typed configuration loaded once from the environment.
//! - [`connect`]: builds a `sqlx::PgPool` from a [`DbConfig`].
//! - [`acquire_workspace`]: acquires a pooled connection and sets
//!   `app.current_principal_id` via `SET LOCAL` so that per-schema RLS
//!   policies can reference it via `current_setting('app.current_principal_id')`.
//! - [`acquire_with_workspace_id`]: preferred helper for issue #429 callers —
//!   sets both `app.workspace_id` and `app.current_principal_id` from a typed
//!   [`uuid::Uuid`].
//! - [`backup::SubstrateBackup`]: seam interface for recording backup events.
//!   RPO ≤ 5 min, RTO ≤ 15 min — see `docs/architecture.md` §Substrate Reliability.
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout.

pub mod backup;
pub mod config;
pub mod pool;

pub use backup::{
    pg_basebackup_args, wal_archive_command_template, BackupError, BackupEvent, BackupOutcome,
    NoopSubstrateBackup, PgBackup, SubstrateBackup,
};
pub use config::DbConfig;
pub use pool::{acquire_with_workspace_id, acquire_workspace, connect};
