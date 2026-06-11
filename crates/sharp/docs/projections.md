# Sharp Projections — Continuous Speculative Merge

Reference for `crates/sharp/src/projections.rs`. For the conceptual model see whitepaper §6.7; for the planned end-state see engineering-plan §7. This document describes what the **Rust crate implements today** and flags where it diverges from those plans and from the deprecated TypeScript prototype.

---

## Problem Statement

The Git pain Sharp targets is the **rebase on `main`**. As a target advances, a feature branch falls behind; eventually someone must rebase, resolve conflicts, and force-push. History is rewritten, signatures break, reviews are invalidated — and for an autonomous-agent harness there is no human in the loop to drive the resolution.

Sharp eliminates the rebase: the merged view is maintained as a *projection* of the merge engine's output, not as a state of the feature branch. The feature's commits, SHAs, and signatures stay stable; merge churn lives elsewhere.

---

## Core Concepts

A **projection** is identified by the triple `(repo_id, branch_ref, target_ref)` and holds the always-up-to-date result of merging `branch_ref` over `target_ref`. It is persisted as one row in `sharp.projections` (migration `0007_sharp_projections.sql`) with a [`ProjectionStatus`]: **`clean`** (merged cleanly; `projection_commit` holds the SHA), **`dilemma`** (could not resolve; `dilemma` jsonb holds the payload, no commit), **`stale`** (out of date; recompute on next access), or **`error`** (recompute failed, e.g. a ref did not resolve; `dilemma` holds the reason). The row also records `branch_tip` / `target_tip` (the SHAs computed against) and `computed_at`.

The whitepaper names the derived ref `refs/sharp-merged/<feature>--<target>`. **This name is conceptual.** The Rust crate does *not* write any such Git ref: the merged commit lives only in the `projection_commit` column. [`write_projection_commit`] deliberately does **not** move any branch ref, so the projection never re-triggers the stale trigger and the feature tip stays exactly what its author committed.

How it differs from the base branch: the projection commit's *parent* is `branch_tip` and its tree is the merge of branch over target — a synthetic, Sharp-authored commit (`Sharp <sharp-projection@sharp.dev>`) reachable from neither the feature nor the target.

---

## Architecture / Design

**Computation strategy: lazy-on-read.** Projections are *not* webhook-pushed or eagerly recomputed. [`register_projection`] inserts (or resets) the row to `stale`. The DB trigger `sharp.mark_projections_stale()` fires `AFTER INSERT OR UPDATE ON sharp.refs` and flips every projection using that ref (as `branch_ref` *or* `target_ref`) back to `stale`, unless it already is. [`get_projection`] then reads the row and, if `Stale`, calls [`recompute_projection`] and returns the fresh result; non-stale rows are returned as-is.

So cache invalidation is **trigger-driven** and recomputation is **read-driven**: a target that advances while many branches project onto it marks them all stale cheaply, but only the ones someone reads get recomputed.

**Recompute** ([`recompute_projection`]) resolves both refs via [`refs::resolve_ref`], materializes each commit's `path → content` map with [`materialize_tree`] (reconstructed from `sharp.commit_paths`, not tree objects), and combines them with `combine_text`: a path on **both** sides runs `three_way_merge(target, branch, target)` (target as the merge base — a v1 LCA approximation, not a real common-ancestor walk); a path on **one** side only is taken verbatim (an addition, never a deletion).

**Failure / conflict handling:**

- Conflict markers left by the merge (`<<<<<<< ours` / `>>>>>>> theirs`, detected by `has_conflict`) → status `dilemma` with a payload listing `involved_paths`; no commit written.
- Either ref fails to resolve → status `error` via `store_error`, with `{ "reason": ... }`.
- Otherwise → status `clean`; a fresh projection commit is written and `projection_commit` / `branch_tip` / `target_tip` / `computed_at` are updated atomically.

Outstanding dilemmas are a *queryable signal*: `list_projections(pool, repo_id, Some(ProjectionStatus::Dilemma))` turns "the target moved and our feature is now in trouble" into something you can poll, rather than a surprise at merge time.

---

## API / Interface

**Implemented (Rust).** The crate exposes an async Rust API only — there is no HTTP server or CLI in `crates/sharp`:

- `register_projection(pool, repo_id, branch_ref, target_ref) -> ProjectionRow`
- `get_projection(pool, repo_id, branch_ref, target_ref) -> Option<ProjectionRow>` (recomputes if stale)
- `list_projections(pool, repo_id, Option<ProjectionStatus>) -> Vec<ProjectionRow>`
- `delete_projection(pool, repo_id, branch_ref, target_ref)`
- `recompute_projection(...)` and `materialize_tree(...)` (lower-level)

**Planned only.** The TypeScript prototype (`deprecated/sharp-ts/.../routes-projections.ts`) and engineering-plan §7 describe an HTTP surface (`POST/GET/DELETE /repos/:repo/projections`, with `?status=` filter and `<branch>__<target>` path encoding) and CLI verbs (`sharp project`, `sharp project list`, `sharp project preview`, `sharp merge`). None of these exist in the Rust crate yet.

---

## Examples

```rust
register_projection(&pool, repo_id, "refs/heads/feat/x", "refs/heads/main").await?;
let p = get_projection(&pool, repo_id, "refs/heads/feat/x", "refs/heads/main")
    .await?
    .expect("registered");
match p.status {
    ProjectionStatus::Clean   => { /* p.projection_commit is the merged commit */ }
    ProjectionStatus::Dilemma => { /* inspect p.dilemma.involved_paths */ }
    _ => {}
}
```

When `refs/heads/main` later advances, the trigger flips this row to `stale`; the next `get_projection` recomputes against the new tip automatically.

---

## Tradeoffs (Performance Model)

Recompute is **O(files in both trees)**: two `materialize_tree` reads (a query plus one blob load per path) and a per-path line merge, then writing merged blobs and a JSON commit when clean. It only runs on read of a stale projection.

Laziness is the lever: marking stale is one cheap `UPDATE`, while the expensive merge is deferred until a reader needs it, so idle or abandoned branches never pay. The engineering-plan's "recompute storm" risk (many branches sharing a target) is bounded to *actively-read* branches.

**Not yet implemented:** advisory-lock single-flighting (engineering-plan §7). Concurrent reads of the same stale projection can each kick off a duplicate recompute; the writes are idempotent (`ON CONFLICT DO NOTHING`, last-write-wins on the row), so this is wasteful but not incorrect.

---

## Known Limitations

- **Text-only merge.** Recompute runs `three_way_merge` (Tier-1 *text*) only. The whitepaper's full merge model — Tier 1, intrinsic verification, hooks, Tier 2, Tier 3 — is **not wired into projections**. The TS prototype called the richer `tier1Merge`; the Rust port deliberately uses the plain text merge.
- **No real LCA.** `target_ref` is used directly as the merge base; a genuine common-ancestor walk is a follow-up.
- **No `refs/sharp-merged/...` ref** and **no promotion / `sharp merge` CAS** — the merged commit lives in a column, and the "merge time is a no-op CAS advancing the target to `projection_commit`" property (whitepaper §6.7) is not implemented here.
- **Single-parent JSON commits.** Projection commits use Sharp's single-parent JSON model (`parent = branch_tip`), not the TS prototype's two-parent git-canonical commits — so the projection does not compose via standard two-parent reachability as engineering-plan §7 assumed.
- **No HTTP/CLI/git-export surface** in the Rust crate (see API).
- **Audience.** Both humans and agents, but in practice an agent-facing primitive: dilemmas are meant to be *queried* and resolved by *forwarding commits to the feature branch*, never by editing history — suiting a harness with no interactive rebase loop.
