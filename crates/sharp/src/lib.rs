//! Sharp VCS core — objects, refs, commits, DAG, agent-episode schema,
//! and Rust semantic merge via rust-analyzer.
//!
//! This crate implements the Sharp version control system on the shared
//! Postgres instance (all tables in the `sharp` schema) and provides
//! Tier-1 semantic merge for Rust source files by orchestrating
//! `rust-analyzer` as a subprocess and using `cargo check` as the
//! structural verification gate.
//!
//! # Module layout
//!
//! ## VCS core
//! - [`repo`]         — repo init and lookup (`sharp init`)
//! - [`object`]       — content-addressed object store (`sharp add`)
//! - [`commit`]       — commits, branches, and the DAG (`sharp commit`, `sharp branch`)
//! - [`episode`]      — agent-episode lifecycle (open/append/finish/query)
//! - [`git_interop`]  — Git import and linear export
//!
//! ## Rust semantic merge
//! - [`rust_analyzer_client`] — subprocess orchestration of `rust-analyzer`
//!   over the LSP protocol.
//! - [`cargo_check`]          — run `cargo check --message-format=json` and
//!   parse structured diagnostics.
//! - [`semantic_merge`]       — Tier-1 merge algorithm that uses the above
//!   two tools to resolve rename-vs-edit conflicts and refuse non-compiling
//!   merges.
//!
//! ## Shared
//! - [`error`]   — shared error type
//!
//! # Schema
//!
//! SQL migrations live in `crates/sharp/migrations/`:
//! - `0001_sharp_vcs_schema.sql`     — repos, objects, refs, commit_metadata, commit_paths
//! - `0002_sharp_episode_schema.sql` — episodes, episode_events, episode_artifacts, episode_links
//! - `0003_sharp_git_interop.sql`    — git_objects, git_refs (Git SHA-1 keyed store)
//!
//! # Self-hosting criticality
//!
//! Sharp uses these capabilities to manage its own source.  Rust semantic
//! merge is the required next language after TypeScript because the entire
//! stack is being rewritten in Rust.  Deferring Rust support would break the
//! no-non-compiling-merge guarantee for Sharp's own codebase.
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout and
//! §Sharp subsystem (Tier-1 Rust semantic merge).

pub mod cargo_check;
pub mod commit;
pub mod episode;
pub mod error;
pub mod git_interop;
pub mod object;
pub mod repo;
pub mod rust_analyzer_client;
pub mod semantic_merge;

pub use error::SharpError;
