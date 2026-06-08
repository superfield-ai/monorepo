# Scout: Postgres Provisioning, Migrations, and Schema Map

**Issue:** #426
**Phase:** Substrate foundations
**Feeds:** #427 (schema-sharing boundary), #428 (migration runner), #429 (workspace_id threading), #430 (RLS), #431 (AGE fold), #432 (embedding governance)

---

## Summary

This scout inventories every component's Postgres provisioning mechanism,
migration tooling, schema (tables, vector columns, indexes), and AGE
second-instance usage as of the current codebase state. It is the ground-truth
baseline that #427–#432 must be designed against.

**Key finding:** The Rust crate layer has substantially overtaken the TypeScript
layer. The architecture's target state (one Postgres instance, namespaced
per-component schemas, `workspace_id` threading, recursive-CTE graph traversal)
is already partially encoded in the Rust crates. However the TypeScript repos
(nexum, sharp) continue to run independently with their own provisioning. The
gap between the Rust model and the TypeScript actuals is the main migration risk.

---

## 1. DB Provisioning per Component

### 1a. Nexum — TypeScript repo (`superfield-ai/nexum`)

| Property         | Current state                                                            |
| ---------------- | ------------------------------------------------------------------------ |
| Image            | `pgvector/pgvector:pg16` (port 5432)                                     |
| Provisioning     | `docker-compose.yml` — manual `docker compose up`                        |
| Migration runner | Custom TypeScript: `src/db/migrate.ts`                                   |
| Schema file      | `db/schema.sql` — applied idempotently via `migrate()`                   |
| Schema version   | No version table; raw SQL re-applied on every boot                       |
| Schema namespace | None — all tables live in the `public` schema (`blocks`, `links`, etc.)  |
| Vector columns   | `blocks.embedding vector(384)`, `links.edge_embedding vector(384)` stub  |
| Extensions       | `pgcrypto`, `vector`                                                     |
| DB name          | `nexum` (user: `nexum`, pass: `nexum`)                                   |
| Config env var   | `DATABASE_URL` (default `postgresql://nexum:nexum@localhost:5432/nexum`) |

**Tables:** `corpora`, `documents`, `document_versions`, `blocks`, `version_blocks`,
`links`, `entities`, `corpus_access`, `job_queue`

**Migration mechanism detail:** `migrate()` reads `db/schema.sql`, splits on
semicolons with dollar-quote awareness, and executes each statement. Uses
`CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
throughout — idempotent but cannot undo or version.

**Gap vs. Rust crate:** The Rust `nexum` crate (`crates/nexum/`) uses
fully-qualified `nexum.<table>` references (`nexum.blocks`, `nexum.documents`,
etc.) in `query.rs` and `tests/integration.rs`, but the TypeScript schema
creates tables in `public`. The `ingest.rs` module (the non-test path) uses
unqualified names (`INSERT INTO blocks`). There is no migration SQL file in
the Rust `nexum` crate — it relies on the schema already existing. This is an
integration gap: who creates `CREATE SCHEMA nexum` and the tables inside it?

### 1b. Nexum — AGE second instance

| Property         | Current state                                                           |
| ---------------- | ----------------------------------------------------------------------- |
| Image            | `apache/age:PG16_latest` (port 5433, separate service)                  |
| Provisioning     | `docker-compose.yml` — `postgres-age` service                           |
| Migration runner | `docker-entrypoint-initdb.d` hook + `migrate.ts::migrateAge()`          |
| Schema file      | `db/migrations/0001_age_shim.sql`                                       |
| Graph            | `nexum_links`; vertex label `Block`; edge label `LINK`                  |
| Config env var   | `AGE_DATABASE_URL` (default: empty — AGE is optional)                   |
| Runtime path     | `src/db/age.ts` — lazy pool, silent no-op when `AGE_DATABASE_URL` unset |

**Architecture note:** The architecture doc states this second-Postgres service
has been "removed" (§AGE graph extension). The Rust `nexum` crate confirms:
`query.rs` uses recursive CTEs over `nexum.links` for graph traversal with no
AGE dependency. However the TypeScript `docker-compose.yml` still contains the
`postgres-age` service and `src/db/age.ts` still has the full dual-write path.
This is the non-conforming code that #431 must remove.

**AGE integration seam (TypeScript):**

- `src/db/age.ts::writeAgeEdge()` — dual-write into AGE for every new link
- `src/db/migrate.ts::migrateAge()` — called at end of `migrate()`
- Both are guarded: if `AGE_DATABASE_URL` is unset or AGE extension absent,
  execution continues using only primary instance (soft-fail)

### 1c. Sharp — TypeScript repo (`superfield-ai/sharp`)

| Property         | Current state                                                  |
| ---------------- | -------------------------------------------------------------- |
| Image            | No persistent compose; tests use per-run Docker container      |
| Provisioning     | No docker-compose; production uses `SHARP_DSN` env var         |
| Migration runner | TypeScript: `apps/server/src/migrate.ts`                       |
| Schema version   | `schema_migrations` table (version + name + applied_at)        |
| Migration files  | Sequential `NNNN__name.sql` files in `apps/server/migrations/` |
| Extensions       | None (standard Postgres only — no pgvector, no AGE)            |
| Config env var   | `SHARP_DSN` (required — no default)                            |
| Schema namespace | None — all tables live in `public`                             |

**Migration files:**

| File                    | Contents                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `0001__init.sql`        | `repos`, `objects` (git object store, SHA-256)                                            |
| `0002__refs.sql`        | `refs` (git ref names → object hashes)                                                    |
| `0003__commits.sql`     | Commit-specific tables                                                                    |
| `0004__auth.sql`        | `api_keys` (bearer tokens, scopes: read/write/operator)                                   |
| `0005__episodes.sql`    | `episodes`, `episode_artifacts`, `episode_links`, `episode_redactions`, `representations` |
| `0006__analytics.sql`   | Analytics tables                                                                          |
| `0009__projections.sql` | `projections` + trigger `mark_projections_stale()` on ref updates                         |

Sharp's migration runner is the most structured: `schema_migrations` table,
per-file transactions, skip-applied logic, duplicate-version detection. It is
the model the unified runner should follow.

**Gap vs. Rust crate:** The Rust `sharp` crate (`crates/sharp/`) has its own
migration SQL files in `crates/sharp/migrations/` (`0001_sharp_vcs_schema.sql`
through `0004_sharp_runtime_signal.sql`). These create tables in the `sharp`
PostgreSQL schema (namespaced). The TypeScript `sharp` repo creates tables in
`public`. These two schema sets are not reconciled.

### 1d. CLI repo (`superfield-ai/superfield-cli-ts`)

| Property       | Current state                                                         |
| -------------- | --------------------------------------------------------------------- |
| Store          | `lowdb` — JSON file at `.superfield/issues.json`                      |
| Migration      | `migrate()` shim in `packages/db/index.ts` — no-op                    |
| Schema version | `version: 1` field in the JSON file                                   |
| Postgres usage | `packages/db/pg-container.ts` — test utility only (unused in runtime) |

No runtime Postgres dependency in the CLI repo itself.

### 1e. Rust crates — shared substrate

The Rust crate layer introduces a unified model:

| Crate     | Migration files                                                                | Schema created                      |
| --------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| `sf-db`   | `migrations/0002_substrate_backups.sql`                                        | `substrate`                         |
| `sf-auth` | `src/migrations/0001_auth_schema.sql`                                          | `auth`                              |
| `sharp`   | `migrations/0001_sharp_vcs_schema.sql` through `0004_sharp_runtime_signal.sql` | `sharp`                             |
| `nexum`   | None — no migration SQL file in crate                                          | Expected: `nexum`; Gap: not created |

The `sf-db` crate is the shared connection-pool crate. All component crates
acquire Postgres connections through `sf-db::connect()` and
`sf-db::acquire_workspace()`. No component opens its own pool.

**Key gap:** The `nexum` Rust crate has no migration SQL file. It relies on
an external process to have created `CREATE SCHEMA nexum` and the tables.
As of this scout, no such process exists in the Rust layer — the TypeScript
`db/schema.sql` creates tables in `public`, not in the `nexum` schema.

---

## 2. Current Migration Tooling per Component

| Component      | Runner                     | Versioning                | Reversible? |
| -------------- | -------------------------- | ------------------------- | ----------- |
| Nexum (TS)     | Custom TypeScript          | None (idempotent SQL)     | No          |
| Sharp (TS)     | Custom TypeScript          | `schema_migrations` table | No          |
| sf-auth (Rust) | Not wired yet (file only)  | TBD (unified runner)      | No          |
| sharp (Rust)   | Not wired yet (files only) | TBD (unified runner)      | No          |
| sf-db (Rust)   | Not wired yet (file only)  | TBD (unified runner)      | No          |
| nexum (Rust)   | No migration file at all   | Gap                       | —           |
| CLI lowdb      | No-op shim                 | JSON version field        | N/A         |

**Architecture doc note (gap #4):** "No cross-component migration runner — Open —
tracked in migration-runner issue." Issue #428 will close this gap.

---

## 3. Tables, Vector Columns, and pgvector Indexes

### Nexum TypeScript (`public` schema, `superfield-ai/nexum`)

| Table               | Notable columns                                       | Indexes                                                                                          |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `corpora`           | id, name, description, meta                           | —                                                                                                |
| `documents`         | id, corpus_id, title, current_version_id, external_id | `documents_corpus_id_idx`, `documents_corpus_id_external_id_idx`                                 |
| `document_versions` | id, doc_id, version_num, status                       | UNIQUE (doc_id, version_num)                                                                     |
| `blocks`            | id, doc_id, content_hash, embedding vector(384), tsv  | `blocks_doc_content_hash_idx`, HNSW cosine `blocks_embedding_hnsw_idx`, GIN `blocks_tsv_gin_idx` |
| `version_blocks`    | version_id, block_id, seq                             | `version_blocks_block_id_idx`, UNIQUE `version_blocks_version_seq_idx`                           |
| `links`             | id, src, dst, layer, edge_embedding vector(384)       | `links_src_idx`, `links_dst_idx`, HNSW cosine `links_edge_embedding_hnsw_idx`                    |
| `entities`          | id, type, name, api_key_hash, scopes                  | —                                                                                                |
| `corpus_access`     | entity_id, corpus_id, scopes                          | PK (entity_id, corpus_id)                                                                        |
| `job_queue`         | id, job_type, payload, status, attempts               | `job_queue_pending_idx`                                                                          |

**Vector columns:**

| Table  | Column         | Dimension | Index (name, type, ops)                                   | Status                        |
| ------ | -------------- | --------- | --------------------------------------------------------- | ----------------------------- |
| blocks | embedding      | 384       | `blocks_embedding_hnsw_idx` — HNSW, vector_cosine_ops     | Active                        |
| links  | edge_embedding | 384       | `links_edge_embedding_hnsw_idx` — HNSW, vector_cosine_ops | Stub (NULL; issue #75 writes) |

### Sharp TypeScript (`public` schema, `superfield-ai/sharp`)

No vector columns. Standard Postgres only.

### Auth Rust crate (`auth` schema, `crates/sf-auth/`)

| Table                    | Notable columns                                                               | workspace_id? |
| ------------------------ | ----------------------------------------------------------------------------- | ------------- |
| `auth.sessions`          | token UUID PK, workspace_id UUID NOT NULL, user_id, role, expires_at, revoked | YES           |
| `auth.oauth_tokens`      | id, user_id, provider, access_token, refresh_token, expires_at                | No            |
| `auth.app_installations` | id, workspace_id UUID NOT NULL, installation_id BIGINT, account_login         | YES           |

### Sharp Rust crate (`sharp` schema, `crates/sharp/`)

| Table                     | Notable columns                                                      | workspace_id? |
| ------------------------- | -------------------------------------------------------------------- | ------------- |
| `sharp.repos`             | id, name                                                             | No            |
| `sharp.objects`           | sha256, repo_id, object_type, size_bytes, data                       | No            |
| `sharp.refs`              | id, repo_id, ref_name, target_sha                                    | No            |
| `sharp.commit_metadata`   | commit_sha, repo_id, parent_sha, message, author                     | No            |
| `sharp.commit_paths`      | id, commit_sha, repo_id, path, blob_sha                              | No            |
| `sharp.episodes`          | id, repo_id, title, state, opened_at, metadata                       | No            |
| `sharp.episode_events`    | id, episode_id, seq, event_type, payload                             | No            |
| `sharp.episode_artifacts` | id, episode_id, kind, path, blob_sha, content                        | No            |
| `sharp.episode_links`     | id, src_id, dst_id, kind                                             | No            |
| `sharp.git_objects`       | (repo_id, sha1) PK, kind, data                                       | No            |
| `sharp.git_refs`          | (repo_id, ref_name) PK, sha1, symbolic_target                        | No            |
| `sharp.runtime_signals`   | id, episode_id, deployment_id, signal_kind, source, message, payload | No            |

No vector columns in the `sharp` Rust crate schema.

### Substrate Rust crate (`substrate` schema, `crates/sf-db/`)

| Table               | Notable columns                                | workspace_id? |
| ------------------- | ---------------------------------------------- | ------------- |
| `substrate.backups` | id, completed_at, location, outcome, start_lsn | No            |

### Property-graph tables (Nexum Rust crate, `public` schema implied)

The `causal_chain.rs` module queries `entities` and `relations` tables using
unqualified names (no schema prefix). These are described as "public schema"
in the module doc but no CREATE TABLE statements exist for them in the Rust
crates. They appear to be expected from the Nexum TypeScript schema — but
the TypeScript schema does not have a `relations` table. This is a **gap**.

---

## 4. AGE Extension Usage in Nexum

### Current state (TypeScript repo)

- **Service:** `postgres-age` in `docker-compose.yml` — `apache/age:PG16_latest`, port 5433
- **Graph:** `nexum_links`; vertex label `Block`; edge label `LINK`
- **Data written:** None yet in production code. The scout stub created the
  graph/labels but `writeAgeEdge()` in `src/db/age.ts` is only active when
  `AGE_DATABASE_URL` is set.
- **Runtime path:** `src/db/age.ts` — lazy pool, probes for `age` extension
  presence; silently disabled when `AGE_DATABASE_URL` unset.
- **Migration path:** `migrateAge()` in `migrate.ts` applies SQL files from
  `db/migrations/` against `AGE_DATABASE_URL`; called at the end of `migrate()`.

### Current state (Rust crate)

The Rust `nexum` crate has **no AGE dependency**. Graph traversal uses
recursive CTEs over `nexum.links`. The `query.rs` comment explicitly states:
"Graph traversal uses a recursive CTE (not Apache AGE — see issue #359 which
folded the AGE graph shim)."

### Disposition

Architecture doc states: "The Apache AGE graph shim...that previously required
a second Postgres process on `:5433` has been removed." In the Rust layer this
is true. In the TypeScript layer the code still exists and the `docker-compose.yml`
still has the `postgres-age` service. Issue #431 must remove this.

**Risk — custom Docker image:** Folding AGE into the single Postgres instance
requires an image that includes both `pgvector` and `age` extensions. Neither
the `pgvector/pgvector:pg16` image nor the `apache/age:PG16_latest` image
contains both. A custom image build is required before the second service can
be decommissioned.

---

## 5. workspace_id Column Status Across Schemas

| Component / Table         | workspace_id present? | NOT NULL? | FK to workspaces table?  |
| ------------------------- | --------------------- | --------- | ------------------------ |
| `auth.sessions`           | YES                   | YES       | No (no workspaces table) |
| `auth.app_installations`  | YES                   | YES       | No                       |
| `auth.oauth_tokens`       | No                    | —         | —                        |
| `sharp.repos`             | No                    | —         | —                        |
| `sharp.objects`           | No                    | —         | —                        |
| `sharp.refs`              | No                    | —         | —                        |
| `sharp.commit_metadata`   | No                    | —         | —                        |
| `sharp.commit_paths`      | No                    | —         | —                        |
| `sharp.episodes`          | No                    | —         | —                        |
| `sharp.episode_events`    | No                    | —         | —                        |
| `sharp.episode_artifacts` | No                    | —         | —                        |
| `sharp.episode_links`     | No                    | —         | —                        |
| `sharp.git_objects`       | No                    | —         | —                        |
| `sharp.git_refs`          | No                    | —         | —                        |
| `sharp.runtime_signals`   | No                    | —         | —                        |
| `substrate.backups`       | No                    | —         | —                        |
| Nexum TS `blocks`         | No                    | —         | —                        |
| Nexum TS `documents`      | No                    | —         | —                        |
| Nexum TS `corpora`        | No                    | —         | —                        |
| Nexum TS `links`          | No                    | —         | —                        |
| All other tables          | No                    | —         | —                        |

**There is no `workspaces` table anywhere.** Issue #429 requires one to be
created as the FK target before `workspace_id` can be added with a foreign-key
constraint. The `auth.sessions` table already has `workspace_id UUID NOT NULL`
but without a FK reference (the workspaces table does not exist yet).

---

## 6. Schema-Sharing Boundary Options and Tradeoffs

The architecture decision (closed by issue #355) is **namespaced schemas per
component** in a single Postgres instance. This is already partially implemented
in the Rust crates. The choice is documented here with tradeoffs for #427.

### Option A: Single `public` schema, all tables flat (rejected)

- **Pro:** No schema-qualification required in SQL; simple setup.
- **Con:** Name collisions (`api_keys` in both Sharp TS and Nexum; `episodes`
  in Sharp, orchestrator, and possibly others). Migration ownership unclear.
  RLS cannot be scoped per component without prefix conventions.
- **Status:** This is the current TypeScript state — neither nexum nor sharp
  uses schema namespacing. It must be migrated away from.

### Option B: Separate Postgres database per component (rejected)

- **Pro:** Maximum isolation; no cross-contamination risk.
- **Con:** Cross-component joins require `dblink` or FDW (network hop, no
  atomic transactions). Eliminates the join advantage of a single instance.
- **Status:** Rejected by architecture doc.

### Option C: Per-component schemas in one Postgres instance (chosen)

- **Pro:** Cross-component joins are plain SQL; atomic transactions span
  components; RLS per schema; no name collisions.
- **Con:** Schema-qualified SQL everywhere cross-component; migration
  coordination needed across component owners.
- **Status:** Chosen. Already implemented in Rust crates. Must be propagated
  to TypeScript layer during migration.

### Intra-component schema boundary: what goes in each schema

| PostgreSQL schema | Owner crate/component | Current migration file            |
| ----------------- | --------------------- | --------------------------------- |
| `auth`            | `sf-auth`             | `0001_auth_schema.sql`            |
| `sharp`           | `sharp` Rust crate    | `0001–0004_sharp_*.sql`           |
| `nexum`           | `nexum` Rust crate    | **Missing** — needs to be created |
| `substrate`       | `sf-db`               | `0002_substrate_backups.sql`      |
| `episodes`        | orchestrator (future) | Not yet created                   |

---

## 7. Integration Points and Risks

| Risk                                                                 | Severity | Detail                                                                                                                                                                                           |
| -------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **nexum Rust crate has no migration SQL**                            | High     | `crates/nexum/` uses `nexum.<table>` in queries but has no `0001_nexum_schema.sql`. The `nexum` schema and tables must be created before any Rust ingest or query runs.                          |
| **TypeScript Nexum tables are in `public`, Rust expects `nexum`**    | High     | `ingest.rs` uses unqualified names (`INSERT INTO blocks`); `query.rs` and tests use `nexum.blocks`. Under the target state both must use `nexum.<table>`. Requires a migration to rename schema. |
| **`entities` and `relations` tables for causal_chain are undefined** | High     | `causal_chain.rs` queries `entities` and `relations` unqualified. The TypeScript schema has `entities` but no `relations`. No Rust migration creates these.                                      |
| **AGE second-service still in TypeScript docker-compose**            | High     | Architecture says removed; TypeScript still has it. `src/db/age.ts` dual-write code still active when `AGE_DATABASE_URL` is set.                                                                 |
| **No `workspaces` table**                                            | High     | All FK-backed `workspace_id` columns (#429) need a parent table. Must be created before adding workspace_id FKs to other tables.                                                                 |
| **No RLS on any table**                                              | High     | Architecture requires per-schema RLS. Currently `sf-db::acquire_workspace` sets `app.current_principal_id` but no table has `ENABLE ROW LEVEL SECURITY`.                                         |
| **No unified migration runner**                                      | High     | Each component manages its own migrations. No single entry-point applies all in dependency order.                                                                                                |
| **Sharp Rust crate episodes ≠ orchestrator episodes**                | Medium   | `sharp.episodes` in `0002_sharp_episode_schema.sql` is a Sharp-specific agent session table. The architecture also plans an `episodes` schema (orchestrator-level). These must not collide.      |
| **workspace_id missing from all `sharp.*` and `nexum.*` tables**     | Medium   | RLS cannot be authored until `workspace_id` is present. Issue #429 must add it before #430.                                                                                                      |
| **Custom image needed for AGE + pgvector**                           | Medium   | Issue #431 cannot decommission the second Postgres service without a Docker image that includes both extensions.                                                                                 |
| **`pg-container.ts` duplication**                                    | Low      | Two near-identical files: `packages/db/pg-container.ts` (unused at runtime) and `packages/control/tests/helpers/pg-container.ts` (used). Should consolidate.                                     |
| **Sharp TS `public` schema migration**                               | Medium   | Sharp TS creates tables in `public`. Moving to `sharp.*` schema requires a rename migration that must be coordinated with all existing deployments.                                              |

---

## 8. Phase Branch Interface Stubs Needed

The acceptance criterion requires initializing the `phase/substrate-foundations`
branch with stub boundary interfaces. Based on this survey, the stubs needed are:

1. **`crates/nexum/migrations/0001_nexum_schema.sql`** — creates `nexum` schema
   and all tables matching the TypeScript `db/schema.sql`, but using `nexum.`
   namespace. This is the migration the unified runner will apply.

2. **A `workspaces` table migration** — either in `sf-db` or a new `sf-workspace`
   crate. Required before any `workspace_id` FK can be added.

3. **`crates/nexum/src/migrate.rs` stub** — a no-op module that documents the
   migration seam, matching the pattern of `sf-auth` migration placement.

These stubs do not need to execute in the scout — they document the interface
so #427–#432 can implement against a stable target without coordination risk.

The `phase/substrate-foundations` branch does not yet exist as of this scout.
It should be created by the first implementing issue (#427 or #428) and all
subsequent substrate issues should branch from it.

---

## 9. Canonical Doc References

- `docs/architecture.md` §Schema namespace assignment — one-binary, one-Postgres constraint
- `docs/architecture.md` §Migration ownership — component migration file locations
- `docs/architecture.md` §Cross-component joins and RLS scoping
- `docs/architecture.md` §AGE graph extension — confirms recursive CTE approach
- `docs/architecture.md` §Current Gaps — gap table with open items
- `docs/scout/386-postgres-provisioning-migration-schemas.md` — predecessor scout (issue #386)
- `superfield-ai/nexum`: `db/schema.sql`, `db/migrations/0001_age_shim.sql`, `src/db/migrate.ts`, `src/db/age.ts`
- `superfield-ai/sharp`: `apps/server/migrations/*.sql`, `apps/server/src/migrate.ts`
- `crates/sf-auth/src/migrations/0001_auth_schema.sql`
- `crates/sharp/migrations/0001_sharp_vcs_schema.sql` through `0004_sharp_runtime_signal.sql`
- `crates/sf-db/migrations/0002_substrate_backups.sql`
- `crates/sf-db/src/pool.rs` — `acquire_workspace()` sets `app.current_principal_id`
- `crates/nexum/src/causal_chain.rs` — queries `entities`, `relations` (unqualified, undefined)
