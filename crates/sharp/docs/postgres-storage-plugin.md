# The PostgreSQL Storage Plugin

> **Scope — one swappable substrate's implementation, not the product spec.**
> This document describes the concrete schema Sharp's **v1 PostgreSQL storage
> plugin** uses to realize the data model specified in [`whitepaper.md`](./whitepaper.md)
> §4–§5. PostgreSQL is the one substrate Sharp ships and optimizes for v1, but it
> is reached through a loosely-coupled storage boundary (whitepaper §2.3,
> [`storage-substrate.md`](./storage-substrate.md)); it is **one implementation,
> not the architecture**. The merge algebra, conflict terms, serializability, and
> the merge tiers run in Rust _above_ this substrate, not inside it. Nothing in
> the product thesis depends on the schema below; another substrate (a different
> database, flat files, Git metadata) could realize the same data model.
>
> The field tables in whitepaper §4–§5 are normative for the _meaning_ of each
> entity; this document is normative only for how the v1 Postgres plugin lays
> them out. Where the two disagree, the whitepaper's conceptual model wins and
> this plugin converges on it.
>
> **No literal SQL DDL.** To keep `crates/sharp/docs/` free of SQL (enforced by
> `scripts/check-sharp-doc-framing.sh`), the schema is given as field/relation
> tables rather than `CREATE TABLE` statements. The shipped migrations under
> `crates/sharp/migrations/000N_sharp_<name>.sql` are the executable source of
> truth for exact column types, constraints, and indexes.

---

## 1. Object and Ref Plane

These relations realize whitepaper §4.1–§4.2. They are substrate-agnostic in
shape; Postgres is chosen for the provenance and DAG retrieval that sits above
them.

### `objects` (realizes §4.1)

| Column       | Postgres type | Notes                                                              |
| ------------ | ------------- | ------------------------------------------------------------------ |
| `id`         | `bytea`       | Primary key. The object's content-addressing hash.                 |
| `algo`       | `text`        | Default `sha1`; constrained to `sha1` or `sha256` (§4.0).          |
| `kind`       | `text`        | `blob`, `tree`, or `commit`.                                       |
| `size`       | `bigint`      | Inflated payload length.                                           |
| `data`       | `bytea`       | The inflated payload (not zlib-deflated; reconstructed on export). |
| `created_at` | `timestamptz` | First-seen timestamp.                                              |

Index: a composite over `(algo, id)` so SHA-1 ↔ SHA-256 mixed repos still plan
cleanly.

### `refs` (realizes §4.2)

| Column            | Postgres type | Notes                                                          |
| ----------------- | ------------- | -------------------------------------------------------------- |
| `repo_id`         | `uuid`        | Part of the primary key.                                       |
| `name`            | `text`        | Part of the primary key; the full ref name.                    |
| `target`          | `bytea`       | The object the ref points at.                                  |
| `target_kind`     | `text`        | `hash` or `symbolic` (for HEAD round-trip).                    |
| `symbolic_target` | `text`        | Nullable; the symbolic ref name when `target_kind = symbolic`. |

Refs advance through a compare-and-swap update: a conditional update that only
succeeds when the stored `target` still equals the expected prior value. A
zero-row result is a CAS failure, which the client retries or surfaces as a "your
push lost a race" error. Ref creation uses insert-if-absent semantics.

---

## 2. Semantic and Metadata Plane

### `representations` (realizes §4.3)

| Column      | Postgres type | Notes                                                                           |
| ----------- | ------------- | ------------------------------------------------------------------------------- |
| `object_id` | `bytea`       | Part of the primary key.                                                        |
| `layer`     | `text`        | Part of the primary key; e.g. `symbols`, `references`.                          |
| `version`   | `text`        | Part of the primary key; the pinned analyzer/grammar version (term-versioning). |
| `data`      | `jsonb`       | The structured representation payload.                                          |

### `commit_metadata` (realizes §4.4)

| Column       | Postgres type | Notes                                               |
| ------------ | ------------- | --------------------------------------------------- |
| `repo_id`    | `uuid`        | Part of the primary key.                            |
| `commit_id`  | `bytea`       | Part of the primary key.                            |
| `namespace`  | `text`        | Part of the primary key; e.g. `review`, `analysis`. |
| `key`        | `text`        | Part of the primary key.                            |
| `value`      | `jsonb`       | The annotation payload.                             |
| `updated_at` | `timestamptz` | Last revision time.                                 |

---

## 3. Episode Plane

These relations realize whitepaper §5.1.

### `episodes`

| Column            | Postgres type | Notes                                                         |
| ----------------- | ------------- | ------------------------------------------------------------- |
| `id`              | `uuid`        | Primary key.                                                  |
| `repo_id`         | `uuid`        | Not null.                                                     |
| `parent_commit`   | `bytea`       | Not null; the state the run started from.                     |
| `promoted_commit` | `bytea`       | Nullable; the produced state on success.                      |
| `agent_identity`  | `text`        | Not null.                                                     |
| `model_id`        | `text`        | Not null. Part of the provenance tuple.                       |
| `harness_version` | `text`        | Not null. Part of the provenance tuple.                       |
| `tool_versions`   | `jsonb`       | Not null. Part of the provenance tuple.                       |
| `decoding_params` | `jsonb`       | Not null. Part of the provenance tuple.                       |
| `status`          | `text`        | Constrained to `started`, `completed`, `failed`, `abandoned`. |
| `started_at`      | `timestamptz` | Not null.                                                     |
| `finished_at`     | `timestamptz` | Nullable.                                                     |

Indexes: `(repo_id, parent_commit)` and `(repo_id, model_id, status)` for the
common episode query patterns; a GIN index over `tool_versions` so containment
queries plan well.

### `episode_artifacts`

| Column        | Postgres type | Notes                                                                                                        |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `episode_id`  | `uuid`        | Part of the primary key; references `episodes(id)`.                                                          |
| `seq`         | `integer`     | Part of the primary key; preserves intra-episode order.                                                      |
| `kind`        | `text`        | Constrained to `prompt`, `context`, `tool_call`, `tool_result`, `intermediate_patch`, `validation`, `judge`. |
| `content_ref` | `bytea`       | Pointer into `objects.id` for large payloads.                                                                |
| `inline`      | `jsonb`       | Small structured payload. Exactly one of `content_ref` / `inline` is present.                                |
| `created_at`  | `timestamptz` | Not null.                                                                                                    |

A size cap constraint keeps `inline` payloads small (≈64 KB); anything larger
must route through `content_ref`.

### `episode_links`

| Column         | Postgres type | Notes                                                                                        |
| -------------- | ------------- | -------------------------------------------------------------------------------------------- |
| `from_episode` | `uuid`        | Part of the primary key; references `episodes(id)`.                                          |
| `to_episode`   | `uuid`        | Part of the primary key; references `episodes(id)`.                                          |
| `relation`     | `text`        | Part of the primary key; constrained to `sibling`, `retry_of`, `replay_of`, `superseded_by`. |
| `created_at`   | `timestamptz` | Not null.                                                                                    |

---

## 4. Analytics Support Relations

These are plugin-side additions that make whitepaper §5 / `episodes.md` analytics
queries cheap. They are not part of the product data model; another substrate
might serve the same queries differently.

### `repos`

Multi-repo servers need a registry; everything else keys to `repo_id`.

| Column           | Postgres type | Notes           |
| ---------------- | ------------- | --------------- |
| `id`             | `uuid`        | Primary key.    |
| `name`           | `text`        | Unique.         |
| `default_branch` | `text`        | Default `main`. |
| `created_at`     | `timestamptz` | Default now.    |

### `commit_paths`

Tracks which file paths a commit touched, populated on commit creation by
walking the diff against the parent. This is the analytics primitive that makes
"all episodes that touched file X" cheap (join `episode → promoted_commit →
commit_paths`).

| Column      | Postgres type | Notes                    |
| ----------- | ------------- | ------------------------ |
| `repo_id`   | `uuid`        | Part of the primary key. |
| `commit_id` | `bytea`       | Part of the primary key. |
| `path`      | `text`        | Part of the primary key. |

Index: `(repo_id, path)` — the hot analytics index.

---

## 5. Migrations and Conventions

- Migration files live under `crates/sharp/migrations/000N_sharp_<name>.sql`,
  applied in order by the runner (`crates/sf-db/src/migrate.rs`), which records
  applied files and only runs pending ones. They are never re-run and never
  edited after release; a later change ALTERs an earlier table from a new
  migration file (e.g. `0005_sharp_refs_model.sql` and `0010_sharp_objects_algo.sql`).
- No ORM: hand-written interfaces sit alongside `sqlx` query calls, matching
  the crate's raw-SQL convention.
- The read-only query passthrough endpoint (operator scope only; whitepaper §6.7,
  `engineering-plan.md` §10.2) is the operator escape hatch for ad-hoc analytics
  against these relations. It is deliberately kept out of the agent harness's
  default scope.

See [`storage-substrate.md`](./storage-substrate.md) for why the storage boundary
is loosely coupled and what it would take to introduce a second substrate, and
[`engineering-plan.md`](./engineering-plan.md) §3 for the server-side
implementation notes that build on this schema.
