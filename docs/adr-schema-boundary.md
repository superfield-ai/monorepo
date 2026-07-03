# ADR: Single-Instance Schema-Sharing Boundary

**ADR number:** 001  
**Decision date:** 2026-05-30  
**Status:** Accepted — closes #427  
**Canonical reference:** `docs/architecture.md` §Single-Instance Database Schema Layout

---

## Context

The Superfield stack consists of several independently-developed components
(Sharp, Nexum, Auth, Orchestrator/Episodes) that share a single Postgres
instance. Before the system can implement migrations, RLS policies, or cross-
component data folds, it must settle on a schema-sharing topology that avoids
table-name collisions, preserves ownership clarity, and allows performant
cross-component joins.

Three topologies were candidates:

| Option | Description                                                                   |
| ------ | ----------------------------------------------------------------------------- |
| **A**  | All components share the default `public` schema — flat table namespace.      |
| **B**  | Each component owns a dedicated PostgreSQL schema within the shared instance. |
| **C**  | Each component gets its own Postgres database (separate `DATABASE_URL`).      |

A fourth question arose separately from topology: whether the Apache AGE graph
extension should run as a second Postgres process (port 5433) or within the
primary instance.

---

## Decision

**Option B: one PostgreSQL schema per component, all within a single Postgres
instance.**

All Rust and TypeScript components share **one Postgres instance** and use
**namespaced schemas** within it. There is no second Postgres process and no
separate database per component.

**AGE sub-decision:** The AGE graph shim has been removed. Graph traversal uses
recursive CTEs over `nexum.links` on the primary instance. Apache AGE requires
a patched Postgres build incompatible with the standard `postgres:16` image
used throughout this stack; recursive CTEs deliver equivalent multi-hop
traversal on any stock Postgres 14+ instance with no extra binary or port.

---

## Rationale

**Why not Option A (flat `public` schema)?**

- Table name collisions are inevitable: `api_keys` appears in both Sharp and
  Nexum auth paths; `sessions` conflicts between auth and potential component
  caches.
- Migration ownership is ambiguous — any component can accidentally modify
  another component's table.
- RLS policies cannot be scoped per component without fragile naming prefixes.

**Why not Option C (separate database per component)?**

- Cross-component joins require `dblink` or Foreign Data Wrappers, adding a
  network hop and preventing atomic transactions that span component boundaries.
- The primary motivation for a shared instance — cheap joins and transactional
  consistency across components — is eliminated.

**Why Option B (namespaced schemas)?**

- Schema names are the Postgres-native namespace mechanism. They eliminate
  collisions without naming prefixes.
- RLS policies attach to individual schemas; `ENABLE ROW LEVEL SECURITY` on a
  table in `sharp` does not affect `nexum` tables.
- Cross-component joins remain a single SQL statement with no FDW or extra
  network hop.
- Migration ownership is unambiguous: each component exclusively controls its
  own schema directory.

---

## Schema namespace assignment

Each component owns its PostgreSQL schema(s). No component may create objects in
another component's schema. Most components own exactly one schema; `sf-db` owns
the substrate and `forge` schemas plus the shared `public.workspaces` identity
table (the documented cross-component exception below).

| PostgreSQL schema | Owner component | Tables (current)                                                                                                                                                                                                                                                     |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharp`           | Sharp           | `repos`, `objects`, `refs`, `commit_paths`, `commit_metadata`, `git_objects`, `git_refs`, `episodes`, `episode_events`, `episode_artifacts`, `episode_links`, `runtime_signals`, `episode_typed_artifacts`, `episode_relations`, `episode_redactions`, `projections` |
| `nexum`           | Nexum           | `corpora`, `documents`, `document_versions`, `blocks`, `version_blocks`, `links`, `entities`, `relations`, `corpus_access`, `job_queue`, `project_nodes`, `page_revisions`                                                                                           |
| `auth`            | Auth (shared)   | `sessions`, `oauth_tokens`, `app_installations`                                                                                                                                                                                                                      |
| `orchestrator`    | Orchestrator    | `gardening_cursor`                                                                                                                                                                                                                                                   |
| `substrate`       | sf-db           | `backups`                                                                                                                                                                                                                                                            |
| `forge`           | sf-db           | `changes`, `validation_runs`, `policies`                                                                                                                                                                                                                             |
| `public`          | sf-db           | `workspaces` (cross-component identity table — see exception below)                                                                                                                                                                                                  |

---

## Migration-file naming convention

Migration files are colocated with each component's source code. The file
naming convention is:

```
<NNNN>_<description>.sql
```

Where:

- `NNNN` is a zero-padded 4-digit sequence number, unique within the
  component's migrations directory (not globally).
- `<description>` is a snake-case summary of the change. It **may** begin with
  the component's schema name (`0001_sharp_vcs_schema.sql`), but the schema
  token is **optional**: each component's migrations directory already
  disambiguates ownership, so a token-free name like `0003_page_revisions.sql`
  is conforming. *(Amended 2026-07-02: the previously mandatory
  `<NNNN>_<schema>_<description>.sql` form was contradicted by the shipped
  files this ADR governs — see Amendment below.)*

Examples:

| File                              | Component | Notes                                             |
| --------------------------------- | --------- | ------------------------------------------------- |
| `0001_sharp_vcs_schema.sql`       | Sharp     | Creates the `sharp` schema and VCS core tables    |
| `0002_sharp_episode_schema.sql`   | Sharp     | Adds episode signal tables under `sharp`          |
| `0001_nexum_schema.sql`           | Nexum     | Creates the `nexum` schema                        |
| `0003_page_revisions.sql`         | Nexum     | Schema token omitted — the directory disambiguates |
| `0009_rls_workspace_isolation.sql`| Sharp     | Schema token omitted — the directory disambiguates |
| `0001_auth_schema.sql`            | Auth      | Creates the `auth` schema and session tables      |

**Rules enforced by convention:**

1. **Schema creation first.** Every component's `0001_*` migration must begin
   with `CREATE SCHEMA IF NOT EXISTS <component>;`. Subsequent migrations may
   assume the schema exists.
2. **Idempotent statements.** All DDL uses `IF NOT EXISTS` / `IF EXISTS` guards
   so migrations are safe to replay: `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
3. **Fully qualified cross-component references.** Any SQL that references a
   table outside the owning schema must use `<schema>.<table>`. Bare table
   names are forbidden in cross-component queries.
4. **Sequence scope.** Sequence numbers are scoped per component directory, not
   globally. The migration runner tracks applied migrations per component using
   the `(component, sequence)` key.
5. **`public`/`workspaces` exception (sf-db).** Workspace identity is
   deliberately cross-component, so `crates/sf-db/migrations/0001_workspaces.sql`
   creates `public.workspaces` in the shared `public` schema — it carries **no**
   `CREATE SCHEMA` statement, and is the one sanctioned departure from rule 1
   (schema creation first). sf-db's own `substrate` schema is first created
   later, in `crates/sf-db/migrations/0002_substrate_backups.sql`. No other
   component may place objects in `public`.
6. **Migration comment header.** Each file opens with a comment block:

```sql
-- Migration: <filename>
-- Owner: <component crate / package>
-- Schema: <schema name>
-- <one-line description>
--
-- All statements are idempotent.
-- See docs/adr-schema-boundary.md
```

### Component migration paths

| Component         | Source migration path                                              |
| ----------------- | ------------------------------------------------------------------ |
| Sharp (Rust)      | `crates/sharp/migrations/`                                         |
| Nexum (Rust)      | `crates/nexum/migrations/`                                         |
| Auth (Rust)       | `crates/sf-auth/src/migrations/`                                   |
| Orchestrator      | `orchestrator/migrations/` (current — `0001_gardening_cursor.sql`) |
| Substrate / sf-db | `crates/sf-db/migrations/`                                         |

---

## RLS and AGE requirements review

### RLS

Workspace-isolation row-level security is **enforced** on both deployment
tracks (see `docs/architecture.md` §Cross-component joins and RLS scoping). The
namespaced schema topology is what makes correct RLS scoping possible:

- `ENABLE` + `FORCE ROW LEVEL SECURITY` is applied per table within a schema,
  with full CRUD policies across the `sharp`/`nexum`/`auth` workspace-keyed
  tables.
- The RLS session key is `app.workspace_id`: policies filter on
  `workspace_id::text = current_setting('app.workspace_id', true)`, and the Rust
  `sf_db::acquire_with_workspace_id` helper sets it via `SET LOCAL` before any
  workspace-keyed table is touched. `app.current_principal_id` is the **legacy**
  variable — `acquire_with_workspace_id` still sets it, but no policy reads it.
  An unscoped connection sees no workspace rows (NULL → fail-closed); a
  `superfield_admin` `BYPASSRLS` role lets migrations and background jobs bypass
  the policies.
- The two tracks mirror each other: the k3s/TS form lives in
  `packages/db/migrations/0001_rls_workspace_isolation.sql`, and the appliance
  form in `crates/sharp/migrations/0009_rls_workspace_isolation.sql` (applied
  last so every schema exists first), each with a passing integration test.
- The schema boundary means policies for `sharp` tables cannot interfere with
  `nexum` tables and vice versa.

### AGE (Apache AGE graph extension)

The AGE graph shim has been removed. The decision to use recursive CTEs over
`nexum.links` rather than AGE-in-instance satisfies the graph traversal
requirement while conforming to the one-binary one-instance constraint:

- Apache AGE requires a patched Postgres build; `postgres:16` does not include
  it.
- Recursive CTEs over `nexum.links` deliver multi-hop graph traversal on any
  stock Postgres 14+ instance.
- The `crates/nexum/src/query.rs` module provides `traverseGraph()`
  (recursive CTE), `isGraphReady()`, and graph traversal over `nexum.links`
  (see `docs/architecture.md` §AGE graph extension).
- AGE-in-instance remains the long-term option if Cypher query volume demands
  it; the namespaced schema boundary does not block that future adoption.

### Embedding

Vector columns are orthogonal to schema topology. All vector columns across
every schema use 384-dimensional vectors from
`sentence-transformers/all-MiniLM-L6-v2` (see `docs/adr-embedding-model.md`
and `docs/architecture.md` §Governed Embedding Standard). The namespaced
schema layout does not constrain embedding dimensionality or model selection.

---

## Consequences

- All new DDL must be placed in the correct component schema directory.
- Cross-component SQL must always use `<schema>.<table>` qualified names.
- Migration order is owned by `docs/architecture.md` (§Single-Instance
  Database Schema Layout); this ADR defers to it by reference. The Rust
  migration runner (`crates/sf-db/src/migrate.rs`) walks `COMPONENT_DIRS` in
  **`sf-db → sf-auth → nexum → sharp → orchestrator`** order — `sf-db` first,
  because it creates `public.workspaces`, which later schemas (e.g.
  `nexum.page_revisions`) reference; the cross-cutting `orchestrator` cursor
  migration sorts last because it depends only on the component schemas
  existing. Since #762 the appliance runner **does** walk
  `orchestrator/migrations/` as the final `COMPONENT_DIRS` entry.
  *(Corrected 2026-07-02: the previously stated
  `auth → nexum → sharp → orchestrator` order contradicted the runner and
  would fail on FK dependencies. Corrected again 2026-07-03: the 2026-07-02
  text said the runner does not walk `orchestrator/migrations/`, which #762
  made false — see Amendments below.)*
- Future components add a row to the schema namespace table above and a new
  migrations directory before writing any DDL.
- RLS policy work can proceed schema-by-schema without coordination between
  component teams.

---

## Amendment — 2026-07-02

Corrections applied in place following the 2026-07-02 red-team concept review
(`docs/code-reviews/2026-07-02-red-team-concept-review.md`, findings R-22 and
R-36). The Decision itself (Option B, namespaced schemas) is unchanged.

- **Migration order (Consequences).** The previously stated
  `auth → nexum → sharp → orchestrator` order contradicted the actual Rust
  runner — it omitted `sf-db` (which must run first: it creates
  `public.workspaces` that `nexum.page_revisions` FKs against) and included
  `orchestrator`, which the runner does not walk. `docs/architecture.md` now
  owns the order (`sf-db → sf-auth → nexum → sharp`); this ADR defers to it
  by reference.
- **Migration-filename convention.** Amended from the mandatory
  `<NNNN>_<schema>_<description>.sql` to `<NNNN>_<description>.sql` with the
  schema token optional: the per-component migrations directory already
  disambiguates ownership, and the shipped files this ADR governs
  (`crates/nexum/migrations/0003_page_revisions.sql`,
  `crates/sharp/migrations/0009_rls_workspace_isolation.sql`, all of
  `crates/sf-db/migrations/`) never carried the token consistently. This
  amendment ratifies reality rather than renaming applied migrations.
- **Embedding model name (§Embedding).** `Xenova/all-MiniLM-L6-v2` (the
  retired JS/ONNX packaging of the same weights) corrected to the governed
  identifier `sentence-transformers/all-MiniLM-L6-v2`, matching
  `docs/adr-embedding-model.md` and architecture.md.
- **Graph-traversal attribution (§AGE).** `packages/db/nexum-graph.ts`
  (retired TypeScript prototype) replaced with `crates/nexum/src/query.rs`,
  the location architecture.md cites.

---

## Amendment — 2026-07-03

Correction applied following the 2026-07-03 open-tensions review
(`docs/code-reviews/2026-07-03-open-tensions-review.md`). The Decision itself
(Option B, namespaced schemas) is unchanged.

- **Migration order (Consequences), orchestrator inclusion.** The 2026-07-02
  amendment stated that the appliance runner does not walk
  `orchestrator/migrations/`. That predates #762: the runner's
  `COMPONENT_DIRS` (`crates/sf-db/src/migrate.rs`) now includes
  `orchestrator/migrations/` as its final entry, so the canonical order is
  **`sf-db → sf-auth → nexum → sharp → orchestrator`** and the appliance
  creates its own `orchestrator.gardening_cursor` table. `docs/architecture.md`
  (§Single-Instance Database Schema Layout) owns the order; this ADR continues
  to defer to it by reference.
