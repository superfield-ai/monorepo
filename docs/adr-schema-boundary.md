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

Each component owns exactly one PostgreSQL schema. No component may create
objects in another component's schema.

| PostgreSQL schema | Owner component | Tables (current)                                                                                                           |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `sharp`           | Sharp           | `repos`, `objects`, `refs`, `commit_paths`, `commit_metadata`, `api_keys`, `projections`                                   |
| `nexum`           | Nexum           | `corpora`, `documents`, `document_versions`, `blocks`, `version_blocks`, `links`, `entities`, `corpus_access`, `job_queue` |
| `auth`            | Auth (shared)   | `sessions`, `oauth_tokens`, `app_installations`                                                                            |
| `episodes`        | Orchestrator    | `episodes`, `episode_events`, `episode_outcomes`                                                                           |

---

## Migration-file naming convention

Migration files are colocated with each component's source code. The file
naming convention is:

```
<NNNN>_<schema>_<description>.sql
```

Where:

- `NNNN` is a zero-padded 4-digit sequence number, unique within the
  component's migrations directory (not globally).
- `<schema>` is the component's PostgreSQL schema name.
- `<description>` is a snake-case summary of the change.

Examples:

| File                            | Component | Notes                                          |
| ------------------------------- | --------- | ---------------------------------------------- |
| `0001_sharp_vcs_schema.sql`     | Sharp     | Creates the `sharp` schema and VCS core tables |
| `0002_sharp_episode_schema.sql` | Sharp     | Adds episode signal tables under `sharp`       |
| `0001_nexum_schema.sql`         | Nexum     | Creates the `nexum` schema                     |
| `0001_auth_schema.sql`          | Auth      | Creates the `auth` schema and session tables   |

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
5. **Migration comment header.** Each file opens with a comment block:

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

| Component             | Source migration path                        |
| --------------------- | -------------------------------------------- |
| Sharp (Rust)          | `crates/sharp/migrations/`                   |
| Nexum (Rust)          | `crates/nexum/migrations/`                   |
| Auth (Rust)           | `crates/sf-auth/src/migrations/`             |
| Episodes (TypeScript) | `packages/orchestrator/migrations/` (target) |
| Substrate / sf-db     | `crates/sf-db/migrations/`                   |

---

## RLS and AGE requirements review

### RLS

Row-level security is not yet enabled on any schema (see §Current Gaps in
`docs/architecture.md`). The namespaced schema topology is a prerequisite for
correct RLS scoping:

- `ENABLE ROW LEVEL SECURITY` is applied per table within a schema.
- All schemas will reference `auth.sessions` for identity context via
  `current_setting('app.current_principal_id')` when RLS is enabled.
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
- The `packages/db/nexum-graph.ts` module provides `traverseGraph()`,
  `isGraphReady()`, and `NEXUM_GRAPH_SETUP_SQL`.
- AGE-in-instance remains the long-term option if Cypher query volume demands
  it; the namespaced schema boundary does not block that future adoption.

### Embedding

Vector columns are orthogonal to schema topology. All vector columns across
every schema use 384-dimensional vectors from `Xenova/all-MiniLM-L6-v2` (see
`docs/architecture.md` §Governed Embedding Standard). The namespaced schema
layout does not constrain embedding dimensionality or model selection.

---

## Consequences

- All new DDL must be placed in the correct component schema directory.
- Cross-component SQL must always use `<schema>.<table>` qualified names.
- The migration runner (tracked separately) must apply migrations in component
  dependency order: `auth` → `nexum` → `sharp` → `episodes`.
- Future components add a row to the schema namespace table above and a new
  migrations directory before writing any DDL.
- RLS policy work can proceed schema-by-schema without coordination between
  component teams.
