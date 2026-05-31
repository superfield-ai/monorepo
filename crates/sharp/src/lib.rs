//! Sharp — agent-native VCS core and Rust semantic merge.
//!
//! This crate implements the Sharp version control system on the shared
//! Postgres instance and the Tier-1 semantic merge for Rust source.
//! All VCS tables live in the `sharp` schema.
//!
//! # Module layout
//!
//! - [`repo`]                 — repo init and lookup (`sharp init`)
//! - [`object`]               — content-addressed object store (`sharp add`)
//! - [`commit`]               — commits, branches, and the DAG (`sharp commit`, `sharp branch`)
//! - [`episode`]              — agent-episode lifecycle (open/append/finish/query)
//! - [`git_interop`]          — Git import and linear export
//! - [`rust_analyzer_client`] — subprocess orchestration of `rust-analyzer` over LSP
//! - [`cargo_check`]          — run `cargo check --message-format=json` and parse diagnostics
//! - [`semantic_merge`]       — Tier-1 merge algorithm (rename-aware + compile gate)
//! - [`error`]                — shared error type
//!
//! # Schema
//!
//! SQL migrations live in `crates/sharp/migrations/`:
//! - `0001_sharp_vcs_schema.sql`     — repos, objects, refs, commit_metadata, commit_paths
//! - `0002_sharp_episode_schema.sql` — episodes, episode_events, episode_artifacts, episode_links
//! - `0003_sharp_git_interop.sql`    — git_objects, git_refs (Git SHA-1 keyed store)
//!
//! # Self-hosting gate
//!
//! Sharp manages Superfield's own Rust source (the `crates/sharp` workspace)
//! as its dogfood repo.  Any merge of Sharp's own code passes through the
//! Rust semantic merge path, exercising the no-non-compiling-merge guarantee
//! on production source.  See `docs/architecture.md` §Self-hosting gate.
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout.

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
