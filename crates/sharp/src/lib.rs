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
//! - [`workspace`]            — working-tree snapshot/build-tree/materialize over `sharp.objects`
//! - [`commit`]               — commits, branches, and the DAG (`sharp commit`, `sharp branch`)
//! - [`refs`]                 — branches/tags/HEAD: hash + symbolic refs with CAS updates
//! - [`projections`]          — continuous speculative merge state over `sharp.projections`
//! - [`episode`]              — agent-episode lifecycle (open/append/finish/query)
//! - [`runtime_signal`]       — production error and behavioral signal capture (issue #381)
//! - [`git_canonical`]        — Git-canonical object encode/decode (blob/tree/commit/tag)
//! - [`git_interop`]          — Git import and linear export
//! - [`rust_analyzer_client`]   — subprocess orchestration of `rust-analyzer` over LSP
//! - [`tsserver_bridge_client`] — subprocess orchestration of `tsserver-bridge` via JSON-RPC
//! - [`cargo_check`]            — run `cargo check --message-format=json` and parse diagnostics
//! - [`semantic_merge`]         — Tier-1 Rust merge algorithm (rename-aware + compile gate)
//! - [`semantic_merge_ts`]      — Tier-1 TypeScript merge path (tsserver-bridge rename propagation)
//! - [`file_rename`]            — Jaccard file-rename detection
//! - [`ast_equivalence`]        — tree-sitter AST whitespace-equivalence (Rust)
//! - [`oracle`]                 — Tier-2 oracle conflict scoring scaffold
//! - [`hooks`]                  — pre-merge hooks discovery + execution (HookVeto on nonzero)
//! - [`error`]                  — shared error type
//!
//! # Schema
//!
//! SQL migrations live in `crates/sharp/migrations/`:
//! - `0001_sharp_vcs_schema.sql`       — repos, objects, refs, commit_metadata, commit_paths
//! - `0002_sharp_episode_schema.sql`   — episodes, episode_events, episode_artifacts, episode_links
//! - `0003_sharp_git_interop.sql`      — git_objects, git_refs (Git SHA-1 keyed store)
//! - `0004_sharp_runtime_signal.sql`   — runtime_signals (production error capture, issue #381)
//! - `0005_sharp_refs_model.sql`       — refs: target_kind + symbolic_target, nullable target_sha, XOR check
//! - `0006_sharp_episode_model.sql`    — typed artifacts + provenance + episode_relations + episode_redactions
//! - `0007_sharp_projections.sql`      — projections + mark_projections_stale() trigger on refs
//!
//! # Self-hosting gate
//!
//! Sharp manages Superfield's own Rust source (the `crates/sharp` workspace)
//! as its dogfood repo.  Any merge of Sharp's own code passes through the
//! Rust semantic merge path, exercising the no-non-compiling-merge guarantee
//! on production source.  See `docs/architecture.md` §Self-hosting gate.
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout.

pub mod ast_equivalence;
pub mod cargo_check;
pub mod commit;
pub mod episode;
pub mod error;
pub mod file_rename;
pub mod git_canonical;
pub mod git_interop;
pub mod hooks;
pub mod object;
pub mod oracle;
pub mod projections;
pub mod refs;
pub mod repo;
pub mod runtime_signal;
pub mod rust_analyzer_client;
pub mod semantic_merge;
pub mod semantic_merge_ts;
pub mod tsserver_bridge_client;
pub mod workspace;

pub use error::SharpError;
