//! Unified auth and session crate for Superfield.
//!
//! This crate provides:
//!
//! - **Session management** ([`session`]) — issue and validate sessions backed
//!   by the `auth.sessions` table in the shared Postgres instance.
//! - **Workspace + role context** ([`context`]) — the [`AuthContext`] type
//!   carries the authenticated principal's workspace and role, ready to be
//!   applied to a database connection via `sf_db::acquire_workspace` so that
//!   per-schema RLS policies can fire.
//! - **Federation seam** ([`federation`]) — an [`IdentityProvider`] trait
//!   that external OIDC / SAML implementations plug into.  No specific IdP is
//!   wired here; the seam is the only interface the rest of the codebase
//!   depends on.
//!
//! # Architecture
//!
//! Auth data lives in the `auth` PostgreSQL schema on the single shared
//! Postgres instance.  The `auth` schema is created by the migration in
//! `crates/sf-auth/src/migrations/0001_auth_schema.sql`.
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout and
//! §RLS policies are scoped per schema.

pub mod context;
pub mod federation;
pub mod session;

pub use context::{AuthContext, Role};
pub use federation::{FederatedIdentity, IdentityProvider};
pub use session::{Session, SessionError, SessionStore};
