# Superfield — Architecture

Technical and implementation details for the Superfield appliance substrate. Product scope lives in [`prd.md`](./prd.md); the software required for the vision is derived from first principles in [`technical-requirements.md`](./technical-requirements.md); test strategy lives in [`testing.md`](./testing.md).

> **Scope.** This document covers only components that carry forward into the appliance. The GitHub-based prototype orchestrator — GitOps control plane, planning/dev/doc loop internals, CLI command internals, GitHub App auth, control webapp implementation — was scaffolding used to prove the loop. Its designs are intentionally not documented here and must not be treated as appliance architecture; GitHub is never a requirement of the appliance (see `.agents/agent-warnings.md`). Prototype internals remain in git history.

---

## Superfield Blueprint

The Superfield Blueprint is Superfield's fine-tuned dev agent model: an opinionated model trained on architectural constraints, security principles, design patterns, checklists, and antipatterns that encodes how to build software correctly. The rules are not a runtime config — they are baked into the model's weights.

**Current implementation (interim).** The fine-tuned model is the target. Today the Blueprint is approximated as a compiled YAML rule graph sourced from `dot-matrix-labs/superfield-blueprint` and tracked as a git subtree at `blueprint/`. The compiled graph lives at `blueprint/rules/graph.yaml` (1 231 nodes across ARCH, AUTH, DATA, TEST, DEPLOY, ENV, PROCESS, UX, WORKER), with domain bodies under `blueprint/rules/blueprints/*.yaml` and TypeScript-specific implementation rules under `blueprint/rules/implementations/ts/`.

Each node in the graph carries:

| Field         | Values                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| `number`      | Unique rule ID, e.g. `ARCH-P-001`                                                   |
| `type`        | `threat`, `principle`, `design_pattern`, `architecture`, `checklist`, `antipattern` |
| `description` | Prose statement of the rule                                                         |
| `links`       | Typed edges to related nodes (`depends_on`, `mitigates`, `implements`, etc.)        |
| `deprecated`  | Whether the rule is still active                                                    |

**Target integration.** The Blueprint is a binding input to the validation gate: no change merges without conformance to the constraints it encodes. Advisory-only consultation is insufficient for the appliance.

## Nexum — Company Knowledge Graph

[`superfield-ai/nexum`](https://github.com/superfield-ai/nexum) is the unified operational store for all company knowledge: product vision, requirements, source code, issues, behavioral traces, errors, and the causal links among them — under one schema and one clock. Agents are first-class writers: they record observations, candidate corrections, and outcomes directly into the graph. It is not a log or a warehouse — it is the shared ground truth that every agent, human, and service reasons against without crossing a system boundary.

Nexum is distinct from the Blueprint: where the Blueprint defines the rules agents follow (encoded in the fine-tuned model), Nexum is the live company brain they reason against. The Blueprint tells an agent _how_ to build; Nexum tells it _what_ to build and _what is currently true_.

---

## Single-Instance Database Schema Layout

**Decision date:** 2026-05-30
**Status:** Accepted — full ADR in `docs/adr-schema-boundary.md` (closes #427)

### Decision

All Rust components (Sharp, Nexum, auth, and any future component) share **one Postgres instance** and use **namespaced schemas** within that instance — one PostgreSQL schema per component. There is no second Postgres process and no separate database per component.

Rejected alternatives:

| Option                                                | Why rejected                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One shared `public` schema, all tables flat           | Table name collisions across components (`api_keys` appears in both Sharp and Nexum auth paths); migration ownership is ambiguous; RLS policies cannot be scoped per component without prefix conventions that are error-prone to enforce. |
| Separate Postgres database per component              | Cross-component joins require `dblink` or FDW, adding a network hop and precluding atomic transactions that span component boundaries; eliminates the join advantage of a single instance.                                                 |
| Second Postgres process (Nexum's AGE shim at `:5433`) | Non-conforming with the one-binary one-instance architecture decision. The AGE graph extension must run inside the primary instance as an in-instance extension, not as a separate server.                                                 |

### Schema namespace assignment

Each component owns exactly one PostgreSQL schema. All tables, indexes, sequences, and functions for that component live in its schema. No component may create objects in another component's schema.

| PostgreSQL schema | Owner component | Tables (current)                                                                                                           |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `sharp`           | Sharp           | `repos`, `objects`, `refs`, `commit_paths`, `commit_metadata`, `api_keys`, `projections`                                   |
| `nexum`           | Nexum           | `corpora`, `documents`, `document_versions`, `blocks`, `version_blocks`, `links`, `entities`, `corpus_access`, `job_queue` |
| `auth`            | Auth (shared)   | `sessions`, `oauth_tokens`, `app_installations` (to be defined during auth port)                                           |
| `orchestrator`    | Orchestrator    | `gardening_cursor` (current); `episode_events`, `episode_outcomes` (to be defined; tracks agent behavioral traces)         |

**Schema creation is the first step of each component's migration sequence.** Migration runners call `CREATE SCHEMA IF NOT EXISTS <component>` before any `CREATE TABLE`.

### Table naming convention

Within each schema, table names are unqualified (no prefix). The schema name provides the namespace. Cross-component SQL always uses fully qualified `<schema>.<table>` references.

```sql
-- Correct: qualified reference from an orchestrator query
SELECT e.id, b.content
FROM   orchestrator.gardening_cursor   e
JOIN   nexum.blocks                    b ON b.id = e.workspace_id;

-- Wrong: bare table name from outside the owning schema
SELECT * FROM blocks;  -- which schema? ambiguous — never do this cross-component
```

### Migration ownership

Each component owns its schema's migrations exclusively. Migration files are colocated with the component's source code:

| Component | Migration path                                                               |
| --------- | ---------------------------------------------------------------------------- |
| Sharp     | `superfield-ai/sharp/apps/server/migrations/`                                |
| Nexum     | `superfield-ai/nexum/db/migrations/`                                         |
| Auth      | `crates/sf-auth/src/migrations/` (Rust crate)                                |
| Orchestrator | `orchestrator/migrations/` (current — `0001_gardening_cursor.sql`)        |

The migration runner (tracked separately) applies all pending migrations from all components in dependency order at startup. Component migrations must be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`).

### Cross-component joins and RLS scoping

**Joins are cheap because all schemas live in the same instance.** A query can join `sharp.objects` to `nexum.blocks` to `orchestrator.gardening_cursor` in a single statement with no network round-trip. This is the primary motivation for the single-instance architecture.

**RLS policies are scoped per schema.** When row-level security is introduced (not yet implemented — see Current Gaps), each component's `ENABLE ROW LEVEL SECURITY` and policies apply to its own schema tables only. The `auth.sessions` table provides the identity context that all schemas' policies will reference via `current_setting('app.current_principal_id')`.

#### Sample cross-component query

The query below finds all Sharp commits that reference Nexum document blocks (cross-component semantic traceability — illustrates the join model under the namespaced layout):

```sql
-- Find Sharp commits touching files whose content is semantically linked to
-- a given Nexum document block, joining across the sharp and nexum schemas.
--
-- This runs inside a single Postgres session with no FDW or dblink.
-- Both schemas live in the same database on the same instance.

SELECT
    r.name                                          AS repo_name,
    encode(cp.commit_id, 'hex')                     AS commit_sha,
    cp.path                                         AS file_path,
    b.content                                       AS linked_block_content,
    l.rel_type                                      AS link_type
FROM   sharp.commit_paths     cp
JOIN   sharp.repos             r  ON r.id = cp.repo_id
-- Match file path to a Nexum block's source_path via its parent document
JOIN   nexum.documents         d  ON d.source_path = cp.path
JOIN   nexum.document_versions dv ON dv.doc_id = d.id
JOIN   nexum.version_blocks    vb ON vb.version_id = dv.id
JOIN   nexum.blocks            b  ON b.id = vb.block_id
-- Traverse Nexum semantic links originating from those blocks
JOIN   nexum.links             l  ON l.src = b.id
WHERE  l.layer    = 'semantic'
  AND  l.confirmed IS NOT FALSE   -- include unreviewed and accepted links
ORDER  BY r.name, commit_sha, cp.path;
```

This query compiles and executes correctly under the namespaced schema layout. It would require `dblink` or FDW if the components lived in separate Postgres databases.

### AGE graph extension

The Apache AGE graph shim (`nexum/db/migrations/0001_age_shim.sql`) that previously required a second Postgres process on `:5433` has been removed. Graph traversal now runs on the primary Postgres instance using recursive CTEs over the `nexum.links` table.

**Decision:** Recursive CTEs over `nexum.links` rather than AGE-in-instance.

Apache AGE requires a patched Postgres build; the standard `postgres:16` image used throughout this stack does not ship it. Recursive CTEs over `nexum.links` deliver equivalent multi-hop traversal on any stock Postgres 14+ instance with no patched binary, no compose service, and no second port. AGE-in-instance remains the long-term option if Cypher query volume demands it, but recursive CTEs satisfy current parity and close the architectural gap.

The `packages/db/nexum-graph.ts` module provides `traverseGraph()` (recursive CTE), `isGraphReady()`, and `NEXUM_GRAPH_SETUP_SQL`. Integration tests in `packages/db/tests/nexum-graph.test.ts` verify multi-hop traversal against a single containerised Postgres instance.

---

## Governed Embedding Standard

**Decision date:** 2026-05-31
**Status:** Accepted — closes #360

### Standard

| Property       | Value                                                    |
| -------------- | -------------------------------------------------------- |
| **Model**      | `Xenova/all-MiniLM-L6-v2`                                |
| **Dimensions** | 384                                                      |
| **Runtime**    | Local inference via Xenova (ONNX) — no external API call |
| **Distance**   | Cosine similarity                                        |
| **Index type** | HNSW (cosine) via pgvector                               |

All vector columns across every store **must** use 384-dimensional vectors produced by this model. No other embedding model or dimensionality is permitted without a superseding architecture decision.

### Rationale

- Nexum has shipped `blocks.embedding vector(384)` with `Xenova/all-MiniLM-L6-v2` as its production embedding layer. Standardising on the existing implementation avoids a re-embedding migration.
- Local ONNX inference (Xenova) keeps all vector production inside the one-binary boundary. No external API key, no network call, no vendor dependency at inference time.
- 384 dimensions provide adequate semantic resolution for document-block retrieval while keeping index size and query latency low.
- A single vector space means a Sharp episode can join semantically to a Nexum block in one SQL query, without coordinate-system translation.

Rejected alternatives:

| Option                                     | Why rejected                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI `text-embedding-3-small` (1536-dim) | External API dependency; breaks the one-binary constraint; costs per embedding; dimension mismatch with existing Nexum data requiring a full re-embed. |
| OpenAI `text-embedding-ada-002` (1536-dim) | Same objections as above.                                                                                                                              |
| A larger local model (768+ dim)            | Re-embedding all existing Nexum corpora; larger index; no demonstrated retrieval gain for code/document block workloads.                               |

### Vector column inventory

Every vector column across all stores must match the governed standard. Current inventory:

| Component | Schema  | Table    | Column           | Declared dimension | Status                                             |
| --------- | ------- | -------- | ---------------- | ------------------ | -------------------------------------------------- |
| Nexum     | `nexum` | `blocks` | `embedding`      | 384                | Conforming — HNSW cosine index live                |
| Nexum     | `nexum` | `links`  | `edge_embedding` | 384                | Conforming — stub; population tracked in issue #75 |
| Sharp     | `sharp` | —        | —                | —                  | No vector columns yet; pgvector not installed      |

When Sharp or any future component adds a vector column it **must** declare `vector(384)` and reference this section.

### Adoption rule for new stores

Any migration that introduces a vector column must:

1. Declare the column as `vector(384)`.
2. Add an HNSW cosine index: `CREATE INDEX … USING hnsw (col vector_cosine_ops)`.
3. Reference the governed model in a migration comment: `-- embedding model: Xenova/all-MiniLM-L6-v2, 384-dim`.

---

## Sharp — Tier-1 Rust Semantic Merge

Sharp performs semantic merge for Rust source files using **rust-analyzer** as a subprocess (analogous to how `tsserver` is orchestrated for TypeScript). This is self-hosting-critical: Sharp must semantically merge its own and the stack's Rust source under the no-non-compiling-merge guarantee.

### Components (`crates/sharp`)

| Module                       | Role                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo` / `object` / `commit` | VCS core — objects, refs, commits, and the DAG on the `sharp` schema                                                                                       |
| `episode`                    | Agent-episode lifecycle — open, append, finish, query                                                                                                      |
| `git_interop`                | Git import (SHA-1 keyed store) and linear-only export                                                                                                      |
| `rust_analyzer_client`       | LSP subprocess orchestrator — spawns `rust-analyzer`, performs the initialize handshake, and exposes `get_rename_locations(file, line, col, include_decl)` |
| `cargo_check`                | Structural verification gate — runs `cargo check --message-format=json` and parses compiler errors                                                         |
| `semantic_merge`             | Tier-1 merge algorithm — rename detection, 3-way textual baseline, cargo check gate                                                                        |
| `error`                      | Shared `SharpError` type                                                                                                                                   |

### Merge algorithm (Tier-1)

1. **Rename detection** — for each file changed on "ours" relative to base, ask rust-analyzer (via `textDocument/references`) for the rename-location set of every symbol whose identifier changed. If the same symbol is renamed on "ours" and edited on "theirs", the rename wins and all reference locations are propagated.
2. **Textual baseline** — apply a 3-way line-level merge. The rename-aware pass resolves rename-vs-edit conflicts before the textual merge runs, so the textual merge is clean for renamed symbols.
3. **Verification gate** — run `cargo check` on the merged workspace. A non-zero exit → `SharpError::MergeRefused` with structured diagnostics. No merge that fails to compile reaches storage.

### rust-analyzer subprocess protocol

rust-analyzer speaks LSP (JSON-RPC 2.0) over stdin/stdout with `Content-Length` framing. The client:

1. Spawns `rust-analyzer` with `stdin/stdout` piped.
2. Sends `initialize` with `rootUri` set to the Cargo workspace root.
3. Waits for the `initialize` response, then sends `initialized`.
4. Sends `textDocument/didOpen` for each file to analyze.
5. Sends `textDocument/references` to enumerate rename locations.
6. Sends `shutdown` + `exit` when done.

The binary is located via `PATH` first, then `rustup which rust-analyzer` as a fallback.

### Self-hosting gate

Sharp manages Superfield's own Rust source (`crates/sharp`) as its primary dogfood repository. Any merge of Sharp's own code passes through the Rust semantic merge path, exercising the no-non-compiling-merge guarantee on production source.

1. **Onboarding** — the `crates/sharp` workspace is registered as a Sharp repo via `repo::init`.
2. **Merge routing** — every merge of Sharp's own Rust source passes through `semantic_merge_rust`, which orchestrates `rust-analyzer` for rename enumeration and `cargo check` for structural verification.
3. **Episode recording** — each merge opens an episode (`episode::open`), appends a `merge_result` event (renames propagated, files merged, compile gate outcome), then finishes the episode.

#### Test coverage

| Test                                               | What it proves                                                                   | Requires                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| `self_hosting_gate_semantic_merge_on_sharp_source` | Rename propagation + 3-way merge resolves rename-vs-edit cleanly on Sharp source | Nothing — pure Rust, runs in CI             |
| `self_hosting_gate_compile_gate_refuses_bad_merge` | Compile gate detects and refuses a non-compiling merge output                    | `cargo` on PATH                             |
| `self_hosting_gate_with_episode`                   | Full end-to-end: VCS store + episode recording + semantic merge                  | `DATABASE_URL`, applied migrations, `cargo` |

---

## Substrate Reliability

**Decision date:** 2026-06-02
**Status:** Closed — implemented in PR #423

### Recovery Objectives

| Metric                      | Target       | Notes                                                                    |
| --------------------------- | ------------ | ------------------------------------------------------------------------ |
| **RPO** (Recovery Point)    | ≤ 5 minutes  | WAL archiving interval; last archived segment defines the recovery point |
| **RTO** (Recovery Time)     | ≤ 15 minutes | Restore from daily base backup + replay WAL to the target LSN            |
| **Standby replication lag** | ≤ 30 seconds | Streaming replication to one hot standby                                 |
| **Base backup frequency**   | Daily        | `pg_basebackup` snapshot to durable object storage                       |

These are the minimum targets the shared Postgres instance must meet to satisfy the enterprise availability requirement in the PRD. They are the starting point; stricter targets require multi-region replication and are deferred until an enterprise deployment demands them.

### Architecture

The reliability stack has three layers:

1. **Streaming replication (hot standby)** — one synchronous or near-synchronous standby replica. The primary is configured with `wal_level = replica`, `max_wal_senders ≥ 2`, and `hot_standby = on` on the standby. Replication lag is monitored via `pg_stat_replication.replay_lag`. Standby lag ≤ 30 s is the alerting threshold.

2. **WAL archiving** — `archive_mode = on`; the `archive_command` copies each completed WAL segment to durable object storage (`gs://sf-wal-archive/<env>/` in the current deployment). Combined with the daily base backup, this enables point-in-time recovery to any LSN within the retention window (target: 7 days).

3. **Daily base backup** — a `pg_basebackup` job runs against the primary and writes a consistent filesystem snapshot to durable object storage (`gs://sf-backups/<env>/YYYY-MM-DD/` in the current deployment). Scheduling the job is owned by the appliance's execution environment — no external scheduler is a required dependency.

### Restore Procedure

To recover the shared Postgres instance to time `T`:

1. Stop traffic to the primary.
2. Start a fresh Postgres instance with an empty `PGDATA` directory.
3. Restore the most recent daily base backup into `PGDATA`.
4. Set `restore_command` in `postgresql.conf` to fetch WAL segments from the archive (`gs://sf-wal-archive/<env>/%f`).
5. Set `recovery_target_time = 'YYYY-MM-DD HH:MM:SS'` (or `recovery_target_lsn`) to pin the target.
6. Start Postgres; it replays WAL until the target is reached, then enters normal mode.
7. Verify integrity: run the standard migration health check (`cargo run -p sf-cli -- db status`) and confirm the `schema_migrations` table is intact.
8. Restore traffic to the recovered primary.

Total elapsed time should be under the 15-minute RTO. Steps 3–5 (WAL fetch + replay) dominate; the 5-minute RPO bounds the maximum data loss.

### Seam: `SubstrateBackup`

The `sf-db` crate defines [`SubstrateBackup`] (`crates/sf-db/src/backup.rs`): a trait that operations tooling implements to record backup-completion events. The no-op stub [`NoopSubstrateBackup`] satisfies the interface in tests and in components that have not yet wired a real implementation.

A real implementation will:

1. Receive a [`BackupEvent`] from the backup job runner on successful `pg_basebackup` completion.
2. Insert a row into a `substrate.backup_events` table (schema to be defined).
3. Expose the latest event via [`SubstrateBackup::latest`] for health check queries.

---

## Daemon Lifecycle

<!-- STUB — content forthcoming in #503 -->

See: `crates/sf-cli/src/daemon.rs` and `crates/sf-serve/src/loop_handle.rs`. Content forthcoming in #503.

---

## HTTP Routes

<!-- STUB — content forthcoming in #505 -->

See: `crates/sf-serve/src/routes/` (especially `orchestrator.rs`). Content forthcoming in #505.

---

## Nexum — Page Revision Schema

<!-- STUB — content forthcoming in #504 -->

Content forthcoming in #504.
