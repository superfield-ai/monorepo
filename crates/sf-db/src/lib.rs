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
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout.

pub mod config;
pub mod pool;

pub use config::DbConfig;
pub use pool::{acquire_workspace, connect};
