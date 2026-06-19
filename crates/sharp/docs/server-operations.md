# Sharp Server Operations & Deployment

Operational reference for running Sharp against PostgreSQL: provisioning,
schema migration, scaling, monitoring, disaster recovery, and security.

This document complements [`server-config.md`](./server-config.md), which is
the environment-variable reference. Where that doc describes _what knobs exist_,
this one describes _how to run the thing in production_ and — importantly —
calls out where the documented surface area is currently ahead of the
authoritative Rust crate.

> **Authoritative vs. prototype.** The canonical implementation is the Rust
> crate at `crates/sharp/`. It is a **library** (`[lib] name = "sharp"`), not a
> standalone server: every storage function takes a `&sqlx::PgPool` supplied by
> the embedding binary (`repo::init`, `object::put`, `refs::update_ref`,
> `episode::open`, …). The HTTP server, bearer-token auth, `/metrics`, and the
> migration runner described in `server-config.md` were built in the deprecated
> TypeScript prototype (`deprecated/sharp-ts/`) and are **planned, not yet
> ported**. This doc distinguishes the two throughout.

---

## 1. Problem Statement

Sharp stores a version-control object graph _and_ an agent-episode forensic
record in the same PostgreSQL instance. Operating it well means treating
Postgres as the system of record for both blobs and metadata: a lost or
corrupted database is a lost repository and a lost audit trail. The operational
questions are therefore: how do we stand up a correct schema, keep it migrating
forward safely, scale object/episode ingest, observe latency, recover from
disaster, and isolate tenants — all while the durable bytes live in BYTEA
columns rather than a dedicated CAS.

---

## 2. Core Concepts

- **Single `sharp` schema.** Every table is created under
  `CREATE SCHEMA IF NOT EXISTS sharp` on the shared Postgres instance. There is
  no per-repo database; isolation is row-level via `repo_id`.
- **Content-addressed objects.** `sharp.objects` is keyed by `sha256` (hex of
  the inflated payload) with `repo_id`, `object_type` (`blob|tree|commit`),
  `size_bytes`, and the raw `data BYTEA`. Git-imported bytes live separately in
  `sharp.git_objects`, keyed `(repo_id, sha1)`.
- **Refs with CAS.** `sharp.refs` is a discriminated union (`target_kind` ∈
  `{hash, symbolic}`) with an XOR check between `target_sha` and
  `symbolic_target`. Concurrent ref advances are serialized by compare-and-swap
  (`refs::update_ref`), not by locking.
- **Episodes.** `sharp.episodes` plus append-only `episode_events`, generic
  `episode_artifacts`, complete-model `episode_typed_artifacts` (CAS-or-inline
  XOR), `episode_relations`, and the `episode_redactions` audit log. Provenance
  columns (`model_id`, `agent_identity`, `harness_version`, `tool_versions`,
  `decoding_params`, `parent_commit`, `promoted_commit`) make Sharp a forensic
  record of _what harness ran when a commit landed_.
- **Projections.** `sharp.projections` caches speculative-merge results per
  `(repo_id, branch_ref, target_ref)`; an `AFTER INSERT OR UPDATE` trigger on
  `sharp.refs` (`mark_projections_stale`) invalidates them lazily.

---

## 3. Architecture / Design

### 3.1 Deployment topology

The embedding binary opens one `sqlx::PgPool`
(`PgPoolOptions::new()...connect(DATABASE_URL)`) and shares it across all
async handlers. The dependency is `sqlx 0.8` with features
`postgres, runtime-tokio, tls-rustls, uuid, chrono, json` (workspace
`Cargo.toml`); `tls-rustls` means TLS to Postgres is available out of the box —
use a `sslmode=require` (or stricter) DSN in production.

Because the crate is stateless apart from the pool, it scales horizontally:
run N replicas of the embedding binary against one primary Postgres. The
prototype `startServer` (`deprecated/sharp-ts/.../server.ts`) demonstrates the
intended shape — open the pool, optionally migrate, wire routes, serve — and is
the template for the Rust server binary once it lands.

### 3.2 Schema migration strategy

Migrations are plain SQL files in `crates/sharp/migrations/`, applied in
lexicographic order:

| File                            | Adds                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `0001_sharp_vcs_schema.sql`     | `repos`, `objects`, `refs`, `commit_metadata`, `commit_paths`                            |
| `0002_sharp_episode_schema.sql` | `episodes`, `episode_events`, `episode_artifacts`, `episode_links`                       |
| `0003_sharp_git_interop.sql`    | `git_objects`, `git_refs`                                                                |
| `0004_sharp_runtime_signal.sql` | `runtime_signals`                                                                        |
| `0005_sharp_refs_model.sql`     | refs `target_kind` + `symbolic_target`, XOR check                                        |
| `0006_sharp_episode_model.sql`  | `episode_typed_artifacts`, provenance columns, `episode_relations`, `episode_redactions` |
| `0007_sharp_projections.sql`    | `projections` + `mark_projections_stale()` trigger                                       |

**Forward-only, idempotent.** Every file opens with
`CREATE SCHEMA IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF
NOT EXISTS`, and `0005`/`0007` guard constraint and trigger creation with
`DO $$ … $$` / `CREATE OR REPLACE`. There are **no down-migrations** — rolling
back a bad migration means shipping a _new_ forward migration that undoes it.
`0005`/`0006` show the additive posture: `0005` makes `target_sha` nullable and
adds the discriminator without dropping data; `0006` adds the complete episode
model _alongside_ the generic one (sf-cli and superfield depend on the original
columns) rather than replacing it.

**Implemented vs. planned.** The Rust crate ships the migration _files_ but
**not a runner** — there is no `schema_migrations` table, no `sqlx::migrate!`
macro, and no `SHARP_MIGRATE_ON_BOOT` handling in the crate today. The
prototype (`deprecated/sharp-ts/.../migrate.ts`) tracks applied files in
`schema_migrations(version, name, applied_at)` and applies each file inside its
own transaction. When the Rust server binary lands it must reproduce that:
one transaction per file, recorded in a tracking table, never re-run. Until
then, an operator applies the files manually (see Examples).

### 3.3 Concurrency model

- **Ref contention** is handled by CAS, not locks. `refs::update_ref` runs
  `UPDATE … WHERE target_sha = $expected`; if `rows_affected() == 0` it returns
  `SharpError::RefCasFailed { expected, found }`. The loser retries with the new
  observed value. Per the engineering plan this is the accepted v1 model: "one
  wins, the rest retry."
- **Object puts** are conflict-skip inserts on the `sha256` primary key, so
  concurrent puts of identical content are safe and idempotent.
- **Projection recompute** is intended to be single-flighted per
  `(repo, branch, target)` via a Postgres advisory lock so a stale read does not
  trigger duplicate recomputes (engineering plan §6.7) — verify this is wired in
  `projections.rs` before relying on it under load.
- **Episode redaction** is the one explicitly transactional path
  (`pool.begin()` … `tx.commit()` in `episode.rs`), clearing `content_ref`,
  rewriting `inline`, and inserting an `episode_redactions` row atomically.

---

## 4. API / Interface (operational surface)

The crate exposes storage primitives, not HTTP. The operationally relevant
ones:

- `repo::init` / `repo::find_by_name` — create/lookup a tenant root.
- `object::put` / `object::load` — CAS write/read (`sharp.objects`).
- `refs::update_ref(pool, repo_id, name, expected_old, new_target)` — the CAS
  ref advance; the contention primitive.
- `episode::open` / `append` / `finish` — episode ingest lifecycle.
- `projections::*` — speculative-merge read/recompute.

Environment variables (`server-config.md`): `SHARP_DSN`, `SHARP_PORT`,
`SHARP_LOG_LEVEL`, `SHARP_MIGRATE_ON_BOOT`, `SHARP_AUTH_DISABLED`,
`SHARP_ALLOW_RAW_SHA1`, `SHARP_SLOW_QUERY_MS`, `SHARP_HOOK_TIMEOUT_MS`. **None
of these are parsed by the Rust crate yet** — they describe the prototype/target
server binary. The crate reads only `DATABASE_URL`, and only in integration
tests.

---

## 5. Examples

### 5.1 Deployment checklist

- **Postgres ≥ 16.** `gen_random_uuid()` is used directly as a column default,
  so `pgcrypto`/built-in must be available (Postgres 13+ ships it in core; 16 is
  the prototype's pinned `postgres:16`).
- **Resources (starting point).** 2 vCPU / 4 GB for the DB on a small team;
  budget headroom because blobs live in BYTEA — `objects.data` and
  `git_objects.data` grow with repo size. Re-provision toward the "external CAS"
  pivot if object storage dominates (see §7).
- **TLS.** Use a `sslmode=require` DSN; `sqlx` is built with `tls-rustls`.
- **Connection pool.** Size `PgPoolOptions::max_connections` to roughly
  `(cores × 2) + effective_spindles`, and keep `N_replicas × max_connections`
  below Postgres `max_connections` minus headroom for admin/backups. Use
  PgBouncer (transaction mode) once replica count makes direct pooling tight.
- **Apply migrations** before serving traffic (below).
- **Verify indexes** exist: `objects_repo_id_idx`, `refs_repo_id_idx`,
  `commit_paths_path_idx`, `episodes_repo_id_idx`, `episodes_status_idx`,
  `episode_typed_artifacts_episode_id_idx`, `projections_status_idx`.

### 5.2 Applying migrations manually

```bash
# Authoritative crate has no runner yet — apply files in lex order.
for f in crates/sharp/migrations/*.sql; do
  echo ">> $f"
  psql "$SHARP_DSN" -v ON_ERROR_STOP=1 -1 -f "$f"   # -1 = single transaction
done
```

Each file is idempotent, so re-running the loop after a partial failure is
safe. When the Rust runner lands, prefer `SHARP_MIGRATE_ON_BOOT` (default on)
for single-replica deploys and a one-shot migrate Job for multi-replica
rollouts so pods don't race.

### 5.3 Backup & restore

```bash
# Logical backup of just the sharp schema (objects included — these ARE the blobs).
pg_dump --format=custom --schema=sharp "$SHARP_DSN" > sharp_$(date +%F).dump

# Restore into a fresh database.
pg_restore --clean --if-exists --dbname "$SHARP_DSN" sharp_2026-06-11.dump
```

**Integrity spot-check.** After a restore, verify that every object's stored
hash still matches a hash recomputed over its bytes — scan the `objects`
relation for any row whose stored hash differs from the hash of its `data`, and
expect zero rows. (Run this as a one-off read against the store; it is also a
good candidate for the operator-scoped read-only passthrough.)

For point-in-time recovery, run continuous WAL archiving
(`archive_mode=on`, `archive_command=…`) plus periodic base backups
(`pg_basebackup`) and recover with a `recovery_target_time`. PITR is the only
way to recover an episode/ref state between logical dumps; logical dumps alone
lose everything since the last `pg_dump`.

### 5.4 Example Prometheus queries / alert thresholds (target — not yet emitted)

The `/metrics` endpoint and these series are **planned** (engineering plan §13
lists the metrics surface as in-scope-if-time-permits). Treat the following as
the intended SLOs from v1-plan §3, which are **targets, not measured numbers**:

```promql
# Object put/get p99 latency
histogram_quantile(0.99, sum(rate(sharp_object_op_seconds_bucket[5m])) by (le, op))

# Episode ingest rate (target: > 100 episodes/sec single-node)
sum(rate(sharp_episode_writes_total[1m]))

# Ref CAS retry pressure (contention signal)
rate(sharp_ref_cas_retries_total[5m])
```

| Signal                                               | Target (v1-plan §3) | Alert                                |
| ---------------------------------------------------- | ------------------- | ------------------------------------ |
| commit creation p99                                  | < 50 ms             | page if > 100 ms for 5 m             |
| 10k-file checkout/materialize                        | < 2 s               | warn                                 |
| episode ingest                                       | > 100 episodes/s    | warn if sustained < 50/s             |
| ref CAS retries                                      | low                 | warn on sustained climb (hot branch) |
| slow queries (`SHARP_SLOW_QUERY_MS`, default 250 ms) | rare                | warn on rate increase                |

---

## 6. Tradeoffs

- **Blobs in Postgres.** Storing inflated payloads in BYTEA keeps the system
  single-store and queryable without decompression, but couples object storage
  growth to the database's backup/restore and vacuum cost. v1-plan §3 makes this
  explicit: if the §3 thresholds aren't met, the architecture pivots blobs to a
  dedicated CAS while keeping metadata in Postgres.
- **CAS-and-retry refs.** Cheap and lock-free, but a hot target branch under
  many concurrent pushes spends cycles on retries. Acceptable for v1; an
  optimistic-stash-and-rebase scheme is explicitly deferred.
- **Forward-only migrations.** Simple and auditable, but a mistaken migration
  requires a new corrective migration rather than a rollback — plan releases
  accordingly.
- **Lazy projections.** Recompute-on-read avoids a storm when a shared target
  advances (only actively-read branches pay), at the cost of latency on the
  first read after staleness.

---

## 7. Known Limitations

- **No server binary in the crate.** Auth, `/metrics`, health endpoints
  (`/healthz`, `/readyz`), structured request logging, and the migration runner
  exist only in the deprecated TS prototype. Everything in `server-config.md`'s
  _Deployment_, _Issuing Tokens_, and _Migrations_ sections describes that
  prototype / the target binary, not code in `crates/sharp/`.
- **No token table in the authoritative migrations.** The prototype's
  `api_keys (token_hash bytea PK, principal, scope, created_at, revoked_at)` —
  SHA-256-hashed secrets, four scopes (`read`, `read_no_episodes`, `write`,
  `operator`) — has **no counterpart migration** in `crates/sharp/migrations/`.
  Token management and audit logging are therefore unenforced until ported.
- **Multi-repo isolation is row-level only.** Tenancy is `repo_id` filtering in
  application queries plus `ON DELETE CASCADE` from `sharp.repos`. There are no
  row-level-security policies in the Sharp migrations; isolation depends on every
  query carrying the right `repo_id`. (Postgres RLS for per-workspace isolation
  exists elsewhere in the monorepo but is not applied to the `sharp` schema.)
- **SHA-1DC not wired.** Git intake accepts raw SHA-1 under
  `SHARP_ALLOW_RAW_SHA1`; collision-detection on intake is still a target.
- **Metrics are targets, not measurements.** Every latency/throughput number
  here comes from v1-plan §3 / the engineering plan as an acceptance _target_.
  v1's promise is "we measure"; hitting the thresholds is a v2 commitment.
- **No observability deps.** `Cargo.toml` pulls in no `tracing`, `metrics`, or
  Prometheus crate — the observability surface must be added with the server
  binary.
