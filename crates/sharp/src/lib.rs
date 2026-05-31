//! Sharp VCS core — objects, refs, commits, DAG, and agent-episode schema.
//!
//! This crate implements the Sharp version control system on the shared
//! Postgres instance.  All tables live in the `sharp` schema.
//!
//! # Module layout
//!
//! - [`repo`]    — repo init and lookup (`sharp init`)
//! - [`object`]  — content-addressed object store (`sharp add`)
//! - [`commit`]  — commits, branches, and the DAG (`sharp commit`, `sharp branch`)
//! - [`episode`] — agent-episode lifecycle (open/append/finish/query)
//! - [`error`]   — shared error type
//!
//! # Schema
//!
//! SQL migrations live in `crates/sharp/migrations/`:
//! - `0001_sharp_vcs_schema.sql`     — repos, objects, refs, commit_metadata, commit_paths
//! - `0002_sharp_episode_schema.sql` — episodes, episode_events, episode_artifacts, episode_links
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout.

pub mod commit;
pub mod episode;
pub mod error;
pub mod object;
pub mod repo;

pub use error::SharpError;
