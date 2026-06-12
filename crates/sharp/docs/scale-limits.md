# Bounds and Scale in Sharp

How big can a Sharp repository get, how many episodes can be in flight, and what fails first when a monorepo grows to 100k files and a million commits.

This document distinguishes **MEASURED** limits (exercised by a test or benchmark that exists today) from **TARGET** limits (acceptance thresholds asserted by the engineering plan but not yet measured). As of this writing the Rust crate has **no load, stress, or scale tests** — every number below the "target" line is an aspiration, not an observation. See §7.

---

## 1. Problem Statement

Sharp stores its entire object graph, ref set, commit-path index, episode log, and projection cache in a single Postgres instance (`object.rs`, `refs.rs`, `episode.rs`, `projections.rs`). Postgres-as-store is a deliberate v1 bet: `engineering-plan.md` §3.6 and the risk table at line 783 name "pivot blob storage to an external CAS" as the documented escape hatch if it fails.

The question this raises: at what repo size, file count, commit-graph depth, episode-ingest rate, or concurrency level does the single-Postgres design stop holding its latency budget — and which subsystem degrades first.

## 2. Core Concepts

- **Object** — a blob, tree, or commit addressed by SHA-256, stored inflated in `sharp.objects.data` (`object.rs`); idempotent insert, single-row point read by hash.
- **`commit_paths`** — one row per (commit, path) recording the blob each path resolved to. The analytics primitive, and the source `materialize_tree` walks to reconstruct a tree (`projections.rs:277`).
- **Episode artifact** — a typed event row, either inline jsonb or a CAS pointer into `sharp.objects` (`episode.rs:474`/`:507`).
- **Projection** — a cached branch-over-target merge, recomputed lazily when stale (`projections.rs`).

## 3. Architecture / Design — Where the Cost Lives

**Per-commit Postgres writes.** Commit creation writes the commit object plus one `commit_paths` row per changed path. `engineering-plan.md` §3.6 names this explicitly: "A monorepo commit touching 10k files writes 10k rows. Postgres handles this fine in a single transaction; the cost is real but bounded." Bounded, but linear in changed-file count.

**Tree materialization is N+1.** This is the sharpest cost path and it is unmeasured. `materialize_tree` (`projections.rs:277`) queries the commit's `commit_paths` once, then loops calling `object::load` — a separate `SELECT ... WHERE sha256 = $1` — **once per path** (`projections.rs:300`). A 10k-file tree is 10k sequential round-trips. `recompute_projection` (`projections.rs:465`) materializes **both** branch and target tips, so one recompute on a 10k-file repo is ~20k point reads plus a full-tree `combine_text` pass (`projections.rs:317`). No batching, no streaming, no incremental diff — recompute is whole-tree every time the projection goes stale.

**Object put/get.** Both are single-statement (`object.rs:50`/`:132`). Dedup via `ON CONFLICT` makes re-storing identical content cheap, but does not bound table growth when content is unique (see §7).

**Semantic-representation caching.** Representations are upserted and read per (object, layer) via `POST/GET /representations/:object_id/:layer` (`engineering-plan.md` §4.1). No batch read path; consumers fetch per object.

## 4. Interface Limits (Hard Caps in Code)

| Limit                       | Value                                  | Where                                     | Status                                                                                                             |
| --------------------------- | -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Episode query page size     | clamped to `[1, 1000]`, default 100    | `episode.rs:686` (`list_filtered`)        | MEASURED (enforced in code)                                                                                        |
| Ref-resolution chain depth  | `MAX_RESOLVE_DEPTH = 8` symbolic hops  | `refs.rs:343`                             | MEASURED (enforced in code)                                                                                        |
| Inline artifact payload cap | `octet_length(inline::text) < 64*1024` | `engineering-plan.md` §3.5                | **GAP** — specified in plan; the Rust migration `0002` ships a `content TEXT` column with no such CHECK constraint |
| Ref update concurrency      | optimistic CAS, loser retries          | `refs.rs` CAS, `engineering-plan.md` §3.6 | MEASURED (semantics; no contention benchmark)                                                                      |

## 5. Limits Table (Performance Targets)

Every row here is a **TARGET** from `engineering-plan.md` §3 (line 44) and `v1-plan.md` §3 — the "Postgres-as-store cutoff." None is currently measured by a Rust test.

| Operation                            | Target threshold                | Source                           | Status                                         |
| ------------------------------------ | ------------------------------- | -------------------------------- | ---------------------------------------------- |
| Commit creation latency              | < 50ms p99                      | engineering-plan §3 / v1-plan §3 | TARGET — no benchmark in `crates/sharp`        |
| Checkout / materialize 10k-file tree | < 2s                            | engineering-plan §3              | TARGET — `materialize_tree` is N+1, unmeasured |
| Episode ingest rate                  | > 100 episodes/sec, single node | engineering-plan §3              | TARGET — no ingest benchmark                   |
| Object put/get p99                   | (not separately bounded)        | —                                | UNSPECIFIED                                    |

The bench harness that would produce these numbers is described in `engineering-plan.md` (lines 740–746) as living at `apps/server/bench/` and invoked via `bun run bench`. It targets the **TypeScript** server, not the Rust crate, and a failing bench is explicitly "not a CI-blocker in v1" (line 746). The crate's own `tests/` carry integration and scenario coverage only — no scale dimension.

## 6. Tradeoffs — Scaling Strategy

The committed escape hatch is **not sharding or replication; it is moving blobs out of Postgres**. `v1-plan.md` §6 phrases the success criterion as "Postgres-store benchmarks meet the §3 thresholds, **or** the design pivots blob storage to an external CAS with a documented migration path" (engineering-plan line 783): keep metadata (refs, `commit_paths`, episodes, projections) in Postgres where its transactional and indexed-query strengths matter; move large inflated blobs to a dedicated content-addressed store.

Replication and sharding are **explicitly out of v1 scope** (`v1-plan.md` line 14 defers "replication" alongside Git-server and LFS work) — reasonable v2 items, not promised today. Before either is justified, the N+1 in `materialize_tree` should be collapsed into a single set-returning join (`commit_paths ⋈ objects`), an in-process fix that likely recovers the checkout budget without any topology change.

## 7. Known Limitations + Monitoring Signals

**Limitations:**

- **No load/stress/scale tests exist in the Rust crate.** Every number in §5 is a target asserted by the plan, never an observation. This is the single largest gap in answering "what fails first."
- **Object-table growth is unbounded under unique content.** `engineering-plan.md` §3.6 notes intermediate-patch artifacts "grow linearly with attempts" if a harness emits a unique patch per try; retention is a post-v1 concern.
- **Projection recompute does not scale with tree size** by construction (N+1, whole-tree, both tips).
- **The 64KB inline cap is documented but not enforced** in the shipped migration — callers can inline arbitrarily large jsonb today.

**What fails first (projected):** checkout / projection recompute on large trees, because `materialize_tree`'s per-file round-trips dominate before commit-write amplification or ref-CAS contention become limiting.

**Monitoring signals that you are hitting limits** (per `engineering-plan.md` §10.5, lines 712–715 — structured JSON logs and a Prometheus `/metrics` endpoint):

- `latency_ms` p99 on commit routes climbing past the 50ms target.
- Checkout / projection-recompute latency rising super-linearly with file count — the N+1 signature.
- The **ref-CAS retry counter** climbing under concurrent pushes to one branch (`engineering-plan.md` §3.6).
- The **slow-query counter** firing on `object` point reads — the leading indicator that the blob-to-external-CAS pivot is due.
- `objects` table size growing without bound — the retention-policy trigger.
