# Rust Reorg — Batch N0 Decisions (locked 2026-06-07)

Resolves the architecture decisions that gate the Phase 1-2 porting (reorg.md #22-31).
Grounded in the verified gap audit; reorg.md's TS paths were stale (all sharp paths
missing `apps/`+`src/` segments) and #23's schema half was already shipped.

## Scope this run
- All Phase 1-2 porting: nexum #22-24, sharp #25-31.
- Embedder **inlined now**: copy sf-embed candle BERT into `nexum/src/embed.rs`,
  drop `sf-embed` (and `sf-db`) from `nexum/Cargo.toml`. nexum takes `&PgPool` directly.
- Phases 3-4 (repo create/rename, submodule wiring, sf-db/sf-embed deletion) **excluded** —
  irreversible/outward-facing, require explicit human go-ahead. Note the ordering hazard:
  rename TS repos to `*-ts` (#35/#36) **before** creating the new Rust repos (#32/#33),
  or `gh repo create` collides with the existing names (contradicts reorg.md's stated order).

## Decisions
1. **sharp migration numbers:** 0005 = refs model, 0006 = episodes model, 0007 = projections.
   Worktree snapshot (#30) needs **no** migration (reuses `sharp.objects`).
2. **Refs (#26):** ref ids stored as hex `String` (matches rest of crate), not `bytea`.
   `sharp.refs` ALTER: add `target_kind`, `symbolic_target`; make `target_sha` nullable;
   XOR CHECK (hash xor symbolic). New `SharpError::RefCasFailed`.
3. **Worktree hash model (#30):** reuse existing `sharp.objects` **SHA-256** content store
   (no migration on objects). `git_canonical` (#25) supports **both** Sha1/Sha256 for git
   interop, but native sharp objects stay SHA-256.
4. **Episodes (#27):** **additive** — keep the generic `episode_events`/episode model that
   `sf-cli` and `superfield` depend on; add typed artifacts (`ArtifactKind` enum, CAS
   `content_ref`), provenance fields (parent_commit, model_id, agent_identity), `episode_links`,
   `episode_redactions`, and filtered `list` alongside. Fix any broken callers in the same change.
5. **error.rs:** pre-add all new `SharpError` variants (RefCasFailed, artifact/redaction
   validation, HookVeto) in one prep step to avoid cross-task contention.
6. **nexum #22/#23 shared helpers:** `build_edge_text`/`vector_literal`/`embed_edge` live
   **once** in `links.rs`; #23 lands the helpers + write-path, #22 reuses them.
7. **Out of scope (confirmed):** AGE graph mirroring, InferenceClient abstraction, HTTP
   mode-dispatch (belongs to sf-serve), PDF/DOCX parsers (move to template/framework, #37),
   sharp's own sf-db coupling (not a listed task).

## Gate
Every batch: `cargo check --workspace` then `cargo test -p <crate>`. DB-gated and
rust-analyzer-gated tests are `#[ignore]`'d so CI without Postgres/RA stays green.
