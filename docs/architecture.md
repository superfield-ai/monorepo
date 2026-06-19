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

[`crates/nexum`](crates/nexum) is the unified operational store for all company knowledge: product vision, requirements, source code, issues, behavioral traces, errors, and the causal links among them — under one schema and one clock. Agents are first-class writers: they record observations, candidate corrections, and outcomes directly into the graph. It is not a log or a warehouse — it is the shared ground truth that every agent, human, and service reasons against without crossing a system boundary.

Nexum is distinct from the Blueprint: where the Blueprint defines the rules agents follow (encoded in the fine-tuned model), Nexum is the live company brain they reason against. The Blueprint tells an agent _how_ to build; Nexum tells it _what_ to build and _what is currently true_.

### Page-revision schema and write contract

The `nexum.page_revisions` table is the append-only store for computed knowledge-base page content produced by the gardening loop. It lives in the `nexum` PostgreSQL schema and is created by `crates/nexum/migrations/0003_page_revisions.sql`.

**DDL shape:**

```sql
CREATE TABLE IF NOT EXISTS nexum.page_revisions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID        NOT NULL REFERENCES public.workspaces(id),
    page_name    TEXT        NOT NULL,
    content      TEXT        NOT NULL,
    provenance   TEXT        NOT NULL DEFAULT '',
    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for reading latest revision by (workspace_id, page_name).
CREATE INDEX IF NOT EXISTS page_revisions_workspace_page_idx
    ON nexum.page_revisions (workspace_id, page_name, ingested_at DESC);
```

**Write contract:** The single write entrypoint is `insert_page_revision` in `crates/sf-db/src/page_revision.rs`. Callers supply `workspace_id`, `page_name`, `content`, and `provenance`; the function inserts one row and returns `Ok(())`.

**Idempotency:** Each invocation appends a new revision row. Readers select the latest revision for a `(workspace_id, page_name)` pair by ordering on `ingested_at DESC`. Re-running the gardening step does not corrupt history — it appends a newer row that becomes the effective current revision.

**Migration prerequisite:** The `nexum.page_revisions` table must exist before `insert_page_revision` is called. The daemon's health gate applies all component migrations (including `0003_page_revisions.sql`) before sending `StartupResult::Ok`, so the table is guaranteed to exist for any in-process caller.

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

| PostgreSQL schema | Owner component | Tables (current)                                                                                                                                                                                                                                                     |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharp`           | Sharp           | `repos`, `objects`, `refs`, `commit_paths`, `commit_metadata`, `git_objects`, `git_refs`, `episodes`, `episode_events`, `episode_artifacts`, `episode_links`, `runtime_signals`, `episode_typed_artifacts`, `episode_relations`, `episode_redactions`, `projections` |
| `nexum`           | Nexum           | `corpora`, `documents`, `document_versions`, `blocks`, `version_blocks`, `links`, `entities`, `relations`, `corpus_access`, `job_queue`, `project_nodes`, `page_revisions`                                                                                           |
| `auth`            | Auth (shared)   | `sessions`, `oauth_tokens`, `app_installations` (to be defined during auth port)                                                                                                                                                                                     |
| `orchestrator`    | Orchestrator    | `gardening_cursor`                                                                                                                                                                                                                                                   |
| `substrate`       | sf-db           | `backups`                                                                                                                                                                                                                                                            |
| `forge`           | sf-db           | `changes`, `validation_runs`                                                                                                                                                                                                                                         |

**Schema creation is the first step of each component's migration sequence.** Migration runners call `CREATE SCHEMA IF NOT EXISTS <component>` before any `CREATE TABLE`.

### Table naming convention

Within each schema, table names are unqualified (no prefix). The schema name provides the namespace. Cross-component SQL always uses fully qualified `<schema>.<table>` references.

```sql
-- Correct: qualified reference from an orchestrator query
-- Both tables carry workspace_id as the tenant key; join on that shared column.
SELECT e.workspace_id, e.step_name, pr.page_name
FROM   orchestrator.gardening_cursor   e
JOIN   nexum.page_revisions            pr ON pr.workspace_id = e.workspace_id;

-- Wrong: bare table name from outside the owning schema
SELECT * FROM blocks;  -- which schema? ambiguous — never do this cross-component
```

### Migration ownership

Each component owns its schema's migrations exclusively. Migration files are colocated with the component's source code:

| Component    | Migration path                                                     |
| ------------ | ------------------------------------------------------------------ |
| Sharp        | `crates/sharp/migrations/`                                         |
| Nexum        | `crates/nexum/migrations/`                                         |
| Auth         | `crates/sf-auth/src/migrations/` (Rust crate)                      |
| Orchestrator | `orchestrator/migrations/` (current — `0001_gardening_cursor.sql`) |
| sf-db        | `crates/sf-db/migrations/` (substrate workspace + `forge` tables)  |

The migration runner (tracked separately) applies all pending migrations from all components in dependency order at startup. Component migrations must be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`).

### Cross-component joins and RLS scoping

**Joins are cheap because all schemas live in the same instance.** A query can join `sharp.objects` to `nexum.blocks` to `orchestrator.gardening_cursor` in a single statement with no network round-trip. This is the primary motivation for the single-instance architecture.

**RLS policies are scoped per schema, and are now enforced on both deployment tracks.** The workspace-isolation policies are real: `ENABLE` + `FORCE ROW LEVEL SECURITY` with full CRUD policies across the sharp/nexum/auth tables, keyed on the `app.workspace_id` session variable. They exist in two interchangeable forms with passing acceptance tests:

- the k3s/TS form, `packages/db/migrations/0001_rls_workspace_isolation.sql` (`packages/db/tests/integration/rls-workspace-isolation.test.ts`);
- the appliance form, `crates/sharp/migrations/0009_rls_workspace_isolation.sql` (`crates/sf-db/tests/rls_workspace_isolation_integration.rs`).

Each component's policies apply to its own schema tables only, and `acquire_with_workspace_id()` sets `app.workspace_id` (and the legacy `app.current_principal_id`) via `SET LOCAL` from the real handlers so the policies can fire. An unscoped connection sees no workspace-keyed rows (`current_setting('app.workspace_id', true)` is NULL → fail-closed). A `superfield_admin` BYPASSRLS role lets migrations and background jobs touch every row.

**The two tracks (no longer split on enforcement):** the **k3s / TS-migrator** track applies `packages/db/migrations` via `packages/db/migrator.ts` (the standalone k8s-Job migrator, never imported by the app server). The **appliance daemon** applies its mirror through the Rust migration runner, which walks `COMPONENT_DIRS` (`crates/sf-db/src/migrate.rs`) in `sf-db → sf-auth → nexum → sharp` order; the RLS file is mirrored into the **last** component directory as its highest-numbered file (`crates/sharp/migrations/0009_rls_workspace_isolation.sql`) so it runs after every schema exists, matching the TS migrator's "RLS applied last" ordering. Because sf-db's `0003` workspace_id threading runs before the component tables exist on the appliance order, the appliance RLS migration also self-ensures the `workspace_id` column on each target table before enabling RLS. So on the running self-provisioning appliance, cross-workspace reads/writes are now denied by the database (issue #710).

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

## Change Lifecycle and Validation Gate

The Change lifecycle state machine implements PRD US13 and Constraint §9 (the validation gate). Every proposed change traverses the PRD §6 lifecycle and cannot reach `merged` without a recorded passing validation run and any policy-required approval.

**States (PRD §6):**

```text
draft → validating → awaiting-approval → merged | rejected | abandoned
```

Legal transitions (terminal states — `merged`, `rejected`, `abandoned` — have no outgoing edges):

| From                | Allowed next states                          |
| ------------------- | -------------------------------------------- |
| `draft`             | `validating`, `abandoned`                    |
| `validating`        | `awaiting-approval`, `rejected`, `abandoned` |
| `awaiting-approval` | `merged`, `rejected`, `abandoned`            |

**Storage (`forge` schema, `crates/sf-db/migrations/0004_change_lifecycle.sql`):**

- `forge.changes` — one row per change, carrying its current `state`. A `CHECK` constraint pins the legal state vocabulary at the database level.
- `forge.validation_runs` — validation runs recorded against a change (`queued → running → passed | failed`, PRD §6). A `passed` run is the merge precondition.

**Module:** `crates/sf-db/src/change.rs` owns the state machine. `ChangeState::transition(next, has_passing_validation)` is pure (no database) and enforces both the legal-transition graph and the validation gate: a `* → merged` edge is rejected with `ChangeError::ValidationGate` unless a passing validation run is recorded. `transition_change` persists a transition, deriving the `has_passing_validation` flag from the `forge.validation_runs` rows so the gate cannot be bypassed at the database layer.

**Read route:** `GET /studio/changes/{id}` (`crates/sf-serve/src/routes/change.rs`, auth-required) returns a change and its current state. The policy risk evaluation and change-content generation are out of scope for this state machine and tracked separately.

### AGE graph extension

The Apache AGE graph shim (`nexum/db/migrations/0001_age_shim.sql`) that previously required a second Postgres process on `:5433` has been removed. Graph traversal now runs on the primary Postgres instance using recursive CTEs over the `nexum.links` table.

**Decision:** Recursive CTEs over `nexum.links` rather than AGE-in-instance.

Apache AGE requires a patched Postgres build; the standard `postgres:16` image used throughout this stack does not ship it. Recursive CTEs over `nexum.links` deliver equivalent multi-hop traversal on any stock Postgres 14+ instance with no patched binary, no compose service, and no second port. AGE-in-instance remains the long-term option if Cypher query volume demands it, but recursive CTEs satisfy current parity and close the architectural gap.

The `crates/nexum/src/query.rs` module provides `traverseGraph()` (recursive CTE),
`isGraphReady()`, and graph traversal over `nexum.links`. Integration tests in
`crates/nexum/tests/` verify multi-hop traversal against a single containerised
Postgres instance.

---

## Governed Embedding Standard

**Decision date:** 2026-05-31
**Status:** Accepted — closes #360

### Standard

| Property       | Value                                                               |
| -------------- | ------------------------------------------------------------------- |
| **Model**      | `sentence-transformers/all-MiniLM-L6-v2`                            |
| **Dimensions** | 384                                                                 |
| **Runtime**    | Local inference via `candle` (Rust, CPU/GPU) — no external API call |
| **Distance**   | Cosine similarity                                                   |
| **Index type** | HNSW (cosine) via pgvector                                          |

All vector columns across every store **must** use 384-dimensional vectors produced by this model. No other embedding model or dimensionality is permitted without a superseding architecture decision.

### Rationale

- Nexum has shipped `blocks.embedding vector(384)` with `sentence-transformers/all-MiniLM-L6-v2` as its production embedding layer. Standardising on the existing implementation avoids a re-embedding migration.
- Local inference via candle (Rust) keeps all vector production inside the one-binary boundary. No external API key, no network call, no vendor dependency at inference time.
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

| Component | Schema  | Table    | Column           | Declared dimension | Status                                                           |
| --------- | ------- | -------- | ---------------- | ------------------ | ---------------------------------------------------------------- |
| Nexum     | `nexum` | `blocks` | `embedding`      | 384                | Conforming — HNSW cosine index live                              |
| Nexum     | `nexum` | `links`  | `edge_embedding` | 384                | Conforming — stub; edge_embedding population not yet implemented |
| Sharp     | `sharp` | —        | —                | —                  | No vector columns yet; pgvector not installed                    |

When Sharp or any future component adds a vector column it **must** declare `vector(384)` and reference this section.

### Adoption rule for new stores

Any migration that introduces a vector column must:

1. Declare the column as `vector(384)`.
2. Add an HNSW cosine index: `CREATE INDEX … USING hnsw (col vector_cosine_ops)`.
3. Reference the governed model in a migration comment: `-- embedding model: sentence-transformers/all-MiniLM-L6-v2, 384-dim`.

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
| `ast_equivalence`            | AST whitespace-equivalence via tree-sitter — two Rust source strings are "AST-equal" when their canonical token streams are byte-identical                 |
| `file_rename`                | File-level rename detection via Jaccard line-set similarity — pairs deleted/added files above a similarity threshold                                       |
| `git_canonical`              | Git-canonical object encoding/decoding — the shared `<kind> <size>\0<payload>` hash format for blobs, trees, commits, and tags                             |
| `hooks`                      | Pre-merge (and general) hooks — discovers and runs executables under `.sharp/hooks/<event>/`, treats non-zero exit as a merge veto                         |
| `merge_flow`                 | Self-hosting merge flow — production entry point that orchestrates the full pipeline for Superfield's own Rust workspace through Sharp                     |
| `oracle`                     | Tier-2 oracle scoring — classifies per-path conflicts between a candidate tree and oracle branches to prefer the most downstream-compatible merge          |
| `projections`                | Continuous speculative merge projections — lazily maintains always-up-to-date Tier-1 merge results for `(repo_id, branch_ref, target_ref)` pairs           |
| `refs`                       | Refs (branches, tags, HEAD) over `sharp.refs` — compare-and-swap updates, symbolic targets, hex-string hash ids                                            |
| `runtime_signal`             | Runtime signal capture — records production crashes, health failures, and behavioral signals linked to Sharp episodes and deployments                      |
| `semantic_merge_ts`          | Tier-1 semantic merge for TypeScript — drives `tsserver_bridge_client` for rename detection and propagation, then applies a 3-way textual baseline         |
| `tier1`                      | Unified Tier-1 merge driver — wires classification, file-rename redirection, symbol-rename propagation, whitespace-equivalence, oracle, and hook gate      |
| `tsserver_bridge_client`     | `tsserver-bridge` subprocess harness — spawns the TypeScript bridge script, communicates over newline-delimited JSON-RPC 2.0 on stdio                      |
| `workspace`                  | Working-tree primitives — snapshot a directory to SHA-256 blobs/trees and materialize a tree back to disk, using git-canonical header-prefixed ids         |

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
2. Insert a row into the `substrate.backups` table.
3. Expose the latest event via [`SubstrateBackup::latest`] for health check queries.

---

## Daemon Lifecycle

The Superfield daemon is a long-running background process that owns the local Postgres instance, runs the gardening loop engine, and serves the HTTP API. The CLI auto-spawns it on first use and communicates with it over a Unix socket. All implementation lives in `crates/sf-cli/src/daemon.rs` and `crates/sf-serve/src/loop_handle.rs`.

### State directory

All daemon runtime state lives under `~/.superfield/daemon/`:

| File              | Purpose                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `superfield.sock` | Unix stream socket for client RPCs (created after the health gate passes)                                           |
| `daemon.lock`     | `flock(2)` file used to serialise concurrent spawn attempts (thundering-herd prevention)                            |
| `daemon.json`     | JSON record of the running daemon (`pid`, `version`, `started_at`, `socket_path`); absent when no daemon is running |
| `daemon.log`      | All daemon and agent-step output; opened before `daemonize()` and dup2'd after so nothing is lost during the fork   |

The directory is created on first access (`fs::create_dir_all`). All files are owned by the user running the CLI; no root privileges are required.

### Auto-spawn flow

When the CLI receives any subcommand **except** `status`, `logs`, and `page`, it calls `connect_or_start_daemon()`:

1. **Pre-bind startup-notify socket** — the CLI creates a one-shot Unix stream socket (`~/.superfield/daemon/startup_notify.sock` or the path in `SF_STARTUP_NOTIFY`) and begins listening before the daemon process exists.
2. **Acquire flock** — `flock(daemon.lock, LOCK_EX)` blocks until the calling process is the sole holder. This serialises concurrent invocations and prevents a thundering herd of spawns.
3. **Check `daemon.json`** — if the file exists and the version matches, the daemon is already running; release the lock and connect.
4. **Version mismatch** — if `daemon.json` exists but records a different version, send SIGTERM to the old PID, remove `daemon.json`, and fall through to spawn.
5. **Spawn** — re-execute the current binary (`current_exe()`) with `SF_START_DAEMON=1` in the environment. The child detaches (double-fork / stdin+stdout+stderr redirected to `/dev/null`) and starts the serving layer.
6. **Wait up to 30 s** — the CLI blocks on the startup-notify socket for a `StartupResult` from the daemon. A 60-second wall-clock timeout is enforced by a background thread; expiry returns `DaemonError::StartupTimeout`.

### Startup-notify handshake

After the daemon process starts, it runs the full health gate before signalling the CLI:

1. Call `PostgresProvisioner::start` — provision the appliance-local Postgres instance and wait for `pg_isready` (max 60 s). With no externally-supplied `DATABASE_URL` this is `LocalPostgresProvisioner` (`initdb` into `~/.superfield/daemon/postgres`, `pg_ctl start`, `pg_isready` poll); when `DATABASE_URL` is set the daemon honours it and uses the no-op `TestProvisioner` (no local provisioning).
2. Run the migration runner (`sf_db::run_migrations`) against the now-live instance — applies every component schema in `sf-db → sf-auth → nexum → sharp` order, idempotently, tracked in `schema_migrations`.
3. Write `daemon.json` atomically (write to `.json.tmp`, then `rename`).
4. Bind `superfield.sock`.
5. Send `StartupResult` over the startup-notify socket — a 4-byte little-endian length followed by a bincode-encoded payload:

| Variant                    | Meaning                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| `Ok { version, addr }`     | Daemon fully ready; `addr` is the path to `superfield.sock`                     |
| `AddrInUse`                | Another daemon raced to the socket; caller should re-read `daemon.json`         |
| `Err { reason, log_path }` | Startup failed; `log_path` is the absolute path to `daemon.log` for diagnostics |

The CLI decodes the result and either proceeds (`Ok`) or surfaces the error to the user (`Err`).

### Version handshake

On every connect, the client and daemon exchange their semver version strings as the first RPC. If they differ:

1. The client sends a `Shutdown` RPC to the running daemon.
2. The daemon drains the `LoopHandle` (waits for the current gardening step to commit its cursor), stops Postgres, removes `daemon.json`, and exits cleanly.
3. The client waits for the `flock` on `daemon.lock` to cycle (the old daemon released it on exit), then re-spawns with the new binary.

This ensures the client and daemon always run the same binary version with no manual intervention.

### Shutdown

`superfield daemon stop` sends SIGTERM to the daemon PID recorded in `daemon.json`. The daemon's SIGTERM handler:

1. Calls `LoopHandle::drain()` — signals the gardening loop to finish its current step and stop accepting new ones. The daemon imposes a bounded drain timeout (default 30 s) and falls back to `LoopHandle::abort()` if the loop does not drain in time.
2. Calls `PostgresProvisioner::stop()` — flushes WAL, closes connections, and stops the local Postgres instance via `pg_ctl stop`.
3. Removes `daemon.json`.
4. Exits with code 0.

The `LoopHandle` and `PostgresProvisioner` seams are defined in `crates/sf-serve/src/loop_handle.rs` and `crates/sf-db/src/provisioner.rs` respectively.

### No idle timeout

The daemon runs until it receives SIGTERM (via `superfield daemon stop`) or is killed. There is no idle-timeout or inactivity shutdown. This matches the always-on appliance model: the gardening loop runs continuously, so an idle daemon is still actively working.

### Always-on logging

`daemon.log` is opened before the `daemonize()` call and dup2'd onto stdout and stderr immediately after forking, so no output is lost during the fork. All agent-step output — including stdout/stderr from subprocess calls and any panic backtraces — is captured in this file. The `status` and `logs` subcommands read it without requiring the daemon to be running.

### Foreground / container mode

Setting `SF_NO_DAEMON=1` suppresses `daemonize()`. The CLI still re-executes the binary with `SF_START_DAEMON=1` but the child runs in-process (no fork, no detach, stdio unchanged). This is the intended mode for containers and CI where process supervision is handled externally. The startup-notify handshake still runs; the only difference is that the serving layer occupies the foreground process.

### Seam: PostgresProvisioner

`crates/sf-db/src/provisioner.rs` defines the [`PostgresProvisioner`] trait — the interface through which the daemon owns the local Postgres lifecycle without coupling the `sf-db` crate to any specific runtime.

| Method         | Contract                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `start`        | Ensure Postgres is running and `pg_isready` passes (max 60 s); idempotent — no-op if already running   |
| `stop`         | Stop the instance cleanly after the gardening loop has drained; idempotent — no-op if already stopped  |
| `database_url` | The `DATABASE_URL` the provisioner stood up, or `None` (then the daemon falls back to the environment) |

The real implementation, `LocalPostgresProvisioner`, stands up an appliance-local Postgres with no Docker, no root, and no network database (PRD Constraint §9 self-sufficiency): it runs `initdb` into a durable data directory (`~/.superfield/daemon/postgres`) if absent, starts the instance with `pg_ctl start` bound to `127.0.0.1` with the Unix socket directory pointed at the data dir, polls `pg_isready` until the health gate passes, and ensures the application database exists. It reports the loopback URL via `database_url`. Tests and crates that do not own provisioning — and the path where `DATABASE_URL` is supplied externally — use [`TestProvisioner`], a no-op that returns `Ok(())` and `database_url() == None`.

`LocalPostgresProvisioner` carries several robustness details worth noting: it starts the server detached with `pg_ctl -l <logfile>` and nulled stdio to avoid the pipe deadlock a foreground detached child would otherwise hit; it guards database creation with a `pg_database` lookup via `psql` (rather than `createdb`) so a fresh-cluster race does not error; and it auto-discovers the Postgres binaries via `detect_pg_bin_dir`, which finds Debian/Ubuntu versioned bin directories (`/usr/lib/postgresql/<ver>/bin`) when `initdb`/`pg_ctl` are not on `PATH`.

The daemon calls `start` during the health gate (before sending `StartupResult::Ok`) and `stop` after `LoopHandle::drain()` completes on shutdown. The boot orchestration (`provision → wait healthy → migrate → serve`) lives in `crates/superfield/src/boot.rs::health_gate`, which surfaces provisioning and migration failures as distinct `BootError` variants so a failure at either gate aborts boot non-zero without binding the HTTP server.

### Seam: LoopHandle

`crates/sf-serve/src/loop_handle.rs` defines the [`LoopHandle`] trait — the interface through which the daemon controls the gardening loop engine during graceful shutdown and version-mismatch restart. The trait lives in `sf-serve` because the HTTP layer owns the daemon lifecycle. The HTTP layer does not currently expose a drain route; draining is triggered via the daemon lifecycle (SIGTERM → drain → exit).

| Method  | Contract                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drain` | Signal the loop to finish its current gardening step, commit the cursor, and stop accepting new steps; resolves when the loop has stopped cleanly   |
| `abort` | Cancel any in-flight step immediately (`tokio::task::JoinHandle::abort()`); used when the daemon needs to exit without waiting for the current step |

Callers of `drain` should impose an external timeout (30 s) and fall back to `abort` if the loop does not drain in time. The trait does not enforce a timeout internally.

Tests and phase crates use [`NoopLoopHandle`] — a no-op stub that returns `Ok(())` from both methods immediately.

---

## Gardening Loop Engine

The gardening loop is the continuous background worker that keeps the workspace's knowledge base current. It cycles through nine steps in a fixed order, calling the LLM for each step. Six steps write the result as a `nexum.page_revisions` row; `IntentSpecInference` writes a `spec-delta-proposal` page revision only when `sharp.runtime_signals` are present (otherwise it no-ops and the cursor still advances); `ProjectGraphDerive` instead writes project-graph Feature/Issue nodes; the final step (`CodeChangeProposal`) emits a validated code-change candidate through the Sharp semantic-merge gate. After a full pass it pauses 60 seconds before repeating. A daemon crash is safe: the loop resumes from the last committed cursor step rather than restarting from the beginning.

Source: `crates/sf-loop/src/lib.rs`

### GardeningLoop::start()

```rust
pub fn start(
    pool: sqlx::PgPool,
    config: LoopConfig,
    executor: Arc<dyn AgentExecutor>,
) -> GardeningLoopHandle
```

Spawns the background Tokio task and returns a `GardeningLoopHandle`. On the running daemon path this handle is real: `crates/superfield/src/daemon_runtime.rs` (`boot_loop`) starts the loop via `GardeningLoop::start_observed`, stores the returned `Arc<dyn LoopHandle>`, and the shutdown sequence calls `drain()` (falling back to `abort()` if drain fails) before taking the appliance down — see §Seam: LoopHandle. `NoopLoopHandle` is retired on the running path and survives only as a test/phase double (#671).

`LoopConfig` is built from environment variables via `LoopConfig::from_env()`:

| Field            | Env var           | Default                                 |
| ---------------- | ----------------- | --------------------------------------- |
| `workspace_id`   | `WORKSPACE_ID`    | random UUID                             |
| `blueprint_path` | `BLUEPRINT_PATH`  | `blueprint/rules/graph.yaml`            |
| `llm_api_key`    | `SF_LLM_API_KEY`  | empty string                            |
| `llm_endpoint`   | `SF_LLM_ENDPOINT` | `https://api.anthropic.com/v1/messages` |
| `llm_model`      | `SF_LLM_MODEL`    | `claude-haiku-4-5-20251001`             |

### GardeningStep variants

Defined in `crates/sf-loop/src/steps/mod.rs` as `STEP_ORDER`:

| #   | Variant                | Cursor name             | Output page           | Description                                                                                                                                                                                                                                                                  |
| --- | ---------------------- | ----------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `StrategyResearch`     | `strategy_research`     | `strategy`            | Web research on company strategy → "strategy" page revision                                                                                                                                                                                                                  |
| 2   | `PrdReconcile`         | `prd_reconcile`         | `prd`                 | Reconcile PRD against strategy research → "prd" page revision                                                                                                                                                                                                                |
| 3   | `TechnicalResearch`    | `technical_research`    | `technical`           | Research technical implementation options → "technical" page revision                                                                                                                                                                                                        |
| 4   | `ArchitectureProposal` | `architecture_proposal` | `architecture`        | Derive architecture from PRD + technical + Blueprint rules                                                                                                                                                                                                                   |
| 5   | `PlanProposal`         | `plan_proposal`         | `plan`                | Derive implementation plan from architecture → "plan" page revision                                                                                                                                                                                                          |
| 6   | `IntentSpecInference`  | `intent_spec_inference` | `spec-delta-proposal` | Read `sharp.runtime_signals`, compare actual usage to stated intent (`prd`/`plan`), and propose a spec delta → `spec-delta-proposal` page revision. No-ops (writes nothing) when there are no signals. Never auto-applied — a human confirms or corrects it (#709, PRD US6). |
| 7   | `HolisticReconcile`    | `holistic_reconcile`    | (all five)            | Re-read all five pages and propagate consistency changes                                                                                                                                                                                                                     |
| 8   | `ProjectGraphDerive`   | `project_graph_derive`  | (project graph)       | Derive Feature/Issue project-graph nodes from `plan`/`prd`/`strategy` knowledge → `nexum.project_nodes` via `insert_issue`/`insert_feature` (not a page revision)                                                                                                            |
| 9   | `CodeChangeProposal`   | `code_change_proposal`  | (source diff)         | Select an open node, ask the agent for a source diff, and gate it through the Sharp semantic-merge + `cargo check` gate (`sharp::merge_flow::run_merge_flow`); a non-compiling proposal is refused and discarded, never stored (#706)                                        |

### AgentExecutor trait

```rust
pub trait AgentExecutor: Send + Sync {
    fn run<'a>(&'a self, req: AgentRequest) -> BoxFuture<'a, Result<AgentResponse, AgentError>>;
}
```

Every step calls `AgentExecutor::run` (except `IntentSpecInference` on its no-op path, when no runtime signals exist). For the page-authoring steps the response `content` is stored as page revision content; for `ProjectGraphDerive` the `content` is parsed into Feature/Issue nodes and written to the project graph instead; for `CodeChangeProposal` the `content` is a source diff gated through the Sharp semantic-merge flow. `AgentRequest` carries a `system` prompt and a `user` prompt. `AgentResponse` returns `content` and `provenance` (metadata tag).

Two implementations are provided:

- **`LlmAgentExecutor`** — real implementation. POSTs to `SF_LLM_ENDPOINT` using `SF_LLM_API_KEY` and `SF_LLM_MODEL`. When `SF_OTEL_DISABLED=1` or the API key is empty, all outbound HTTP is skipped and a canned response is returned (safe for CI).
- **`FixtureAgentExecutor`** — deterministic test double. Returns a fixed `AgentResponse` for every call and exposes a `call_count()` counter for test assertions.

Source: `crates/sf-loop/src/agent.rs`

### First-run LLM credential

A fresh appliance ships **no** LLM credential — `SF_LLM_API_KEY` defaults to the empty string (see the `LoopConfig` table above). Without a credential the gardening loop and the studio agent (`WS /studio/ws`) silently degrade to the deterministic `FixtureAgentExecutor`: the loop gardens placeholder content and the agent answers canned echoes. Fixtures are the intended path for CI/tests **only** — never the intended first-run production state (#714).

**First-run step.** To make the appliance do real work, the operator supplies a credential before (or while) the daemon runs:

```bash
export SF_LLM_API_KEY="sk-ant-…"   # operator-supplied; never shipped with the appliance
# optional overrides:
export SF_LLM_ENDPOINT="https://api.anthropic.com/v1/messages"
export SF_LLM_MODEL="claude-haiku-4-5-20251001"
superfield daemon start
```

The appliance does **not** ship a default key and has no secrets-management backend — supplying the credential is an explicit operator action.

**Credential state.** `sf_loop::LlmCredentialState` (`Configured` / `Unconfigured`) is derived from the key via `LoopConfig::credential_state()`:

- `Configured` (non-empty key) → `superfield::daemon_runtime::build_executor` selects the real `LlmAgentExecutor` (`select_executor_kind` → `ExecutorKind::Llm`); `sf_serve::StudioAgent::is_llm_configured()` is `true`, so the studio agent POSTs to the LLM.
- `Unconfigured` (empty/whitespace key) → the deterministic `FixtureAgentExecutor` / studio fixture reply.

**Explicit boot surfacing.** On boot the daemon calls `daemon_runtime::report_credential_state`, which publishes `LlmCredentialState::boot_message()` to the orchestrator log stream (so the control panel shows the state) and, when unconfigured, prints it to stderr. The banner carries **only** the configured/unconfigured _state_ — the key value is never logged, printed, or persisted.

Source: `crates/sf-loop/src/lib.rs` (`LlmCredentialState`), `crates/superfield/src/daemon_runtime.rs` (`build_executor`, `select_executor_kind`, `report_credential_state`), `crates/sf-serve/src/agent.rs` (`StudioAgent::is_llm_configured`).

### BlueprintRules

```rust
pub fn load(path: &Path) -> Result<BlueprintRules, BlueprintError>
pub fn query(&self, keywords: &[&str]) -> String
```

`BlueprintRules::load` reads `blueprint/rules/graph.yaml` once at loop startup. The file is a YAML mapping of rule-name to rule-body. If the file is missing or unreadable, `run_loop` falls back to `BlueprintRules::empty()` (no rules) with a warning log rather than aborting.

`query(keywords)` filters the rule mapping to entries whose key or body contains any of the given keywords. If `keywords` is empty it returns all rules. Used by the `ArchitectureProposal` step to inject relevant architectural constraints into the LLM prompt.

Source: `crates/sf-loop/src/blueprint.rs`

### Cursor resume

The loop's resumable position is stored in `orchestrator.gardening_cursor` (one row per workspace):

```rust
// Commit after a step succeeds:
commit_cursor(&pool, workspace_id, step.name()).await?;

// Load on startup to find the resume index:
let last_step: Option<String> = load_cursor(&pool, workspace_id).await?;
```

`commit_cursor` issues an `INSERT … ON CONFLICT DO UPDATE` (upsert) with the step's canonical name and a `updated_at` timestamp. `load_cursor` reads it back as `Option<String>`. On restart, the loop finds `last_step` in `STEP_ORDER` and resumes from the next index — skipping all already-completed steps in the current pass.

Source: `crates/sf-loop/src/cursor.rs`

---

## HTTP Routes

The daemon serves a single HTTP API over TCP (default bind `0.0.0.0:7000`). All source lives in `crates/sf-serve/src/routes/`. The Unix socket at `~/.superfield/daemon/superfield.sock` is used exclusively for CLI-to-daemon RPC (startup-notify and shutdown); the HTTP routes below are served over the TCP listener.

### Authentication model

Session tokens are issued via `POST /api/auth/session` and accepted as:

- `X-Session-Token: <uuid>` request header, or
- `session` or `superfield_auth` cookie.

The auth middleware validates the token against `auth.sessions` and injects an `AuthContext` extension (workspace UUID + user UUID + role) into every request. Routes marked "Required" return `401 Unauthorized` without a valid token; routes marked "None" are unauthenticated for milestone 1 (localhost-only).

The `role` carried by the `AuthContext` is one of the seven PRD §3 roles (`owner`, `requestor`, `steerer`, `collaborator`, `agent`, `auditor`, `viewer`; the legacy `admin`/`member` names map onto `owner`/`collaborator`). On top of authentication, protected routes enforce **route-level authorization** in `sf_serve::authz`: write routes are gated by `require_write` (the read-only `auditor` and `viewer` roles receive `403 Forbidden`), and Owner-only governance routes — starting/stopping the autonomous loop — are gated by `require_owner` (every non-Owner role receives `403`). These gates run after the auth middleware and complement the per-schema RLS policies that isolate workspace data at the database.

### Route table

| Method       | Path                            | Auth     | Handler module | Description                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------- | -------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`        | `/health`                       | None     | `lib`          | Unauthenticated liveness probe — returns `{"status":"ok"}` for load balancers and E2E setup                                                                                                                                                                                           |
| `GET`        | `/api/auth/health`              | None     | `auth`         | Liveness probe — always returns `{"status":"ok"}`                                                                                                                                                                                                                                     |
| `POST`       | `/api/auth/session`             | None     | `auth`         | Issue a session token for a `(workspace_id, user_id, role)` triple                                                                                                                                                                                                                    |
| `DELETE`     | `/api/auth/session/{token}`     | None     | `auth`         | Revoke an existing session token (idempotent, 204)                                                                                                                                                                                                                                    |
| `POST`       | `/api/auth/register`            | None     | `auth`         | Dev/E2E bootstrap: mint a fresh workspace + user, issue a token                                                                                                                                                                                                                       |
| `GET`        | `/api/status`                   | Required | `api`          | Authenticated liveness probe — echoes workspace/user/role                                                                                                                                                                                                                             |
| `GET`        | `/api/me`                       | Required | `api`          | Current principal identity + RLS session-variable verification                                                                                                                                                                                                                        |
| `GET`        | `/studio/status`                | Required | `studio`       | Studio mode flag + auth context (browser UI health check)                                                                                                                                                                                                                             |
| `GET`        | `/studio/issues`                | Required | `studio`       | List project-graph nodes (Issues and Features) (#672)                                                                                                                                                                                                                                 |
| `POST`       | `/studio/issues`                | Required | `studio`       | Create an Issue node and optional child Features (#672)                                                                                                                                                                                                                               |
| `POST`       | `/studio/issues/update`         | Required + write | `studio`       | Update an Issue/Feature's state and/or title (#672); `require_write` → `403` for `auditor`/`viewer` (#711)                                                                                                                                                                       |
| `POST`       | `/studio/steer`                 | Required + write | `studio`       | Steer/redirect work on a Feature or Issue (#672); `require_write` → `403` for `auditor`/`viewer` (#711)                                                                                                                                                                          |
| `POST`       | `/studio/docs`                  | Required | `ingest`       | Author or upload a document and run the ingest pipeline (#673)                                                                                                                                                                                                                        |
| `GET`        | `/studio/docs`                  | Required | `ingest`       | List the ingested documents for the workspace (#673)                                                                                                                                                                                                                                  |
| `GET`        | `/studio/docs/{file}`           | Required | `ingest`       | Return one document's reconstructed markdown (#673)                                                                                                                                                                                                                                   |
| `GET`        | `/studio/cluster/events`        | Required | `cluster`      | SSE stream of cluster-status transitions driving the live-preview reload. **v0 seeds status once at boot with no periodic poller**, so a mid-session `restarting→healthy` flip is not pushed in production; continuous transition push awaits a health poller (#675)                  |
| `WS`         | `/studio/ws`                    | Required | `ws`           | Agent-chat WebSocket; per `turn`/`steer` frame streams the product agent's reply as one or more `chunk` frames terminated by a `done` frame, emitting an `error` frame on failure. Real in-process agent runtime via `StudioAgent` (#687, PR #699; scout seam #695)                   |
| `GET`        | `/studio/deploy/envs`           | Required | `deploy`       | Discovered deploy environments (#674)                                                                                                                                                                                                                                                 |
| `GET`        | `/studio/deploy/doctor/{env}`   | Required | `deploy`       | Pre-deploy readiness checks for an env (#674)                                                                                                                                                                                                                                         |
| `GET`/`POST` | `/studio/deploy/secrets/{env}`  | Required | `deploy`       | Secret-presence checks per env (`POST` re-runs the checks) (#674)                                                                                                                                                                                                                     |
| `GET`        | `/studio/deploy/ci`             | Required | `deploy`       | Recent CI deploy runs (#674)                                                                                                                                                                                                                                                          |
| `GET`        | `/studio/deploy/migration-log`  | Required | `deploy`       | SSE migration log tail (#674)                                                                                                                                                                                                                                                         |
| `GET`        | `/studio/deploy/rollback-log`   | Required | `deploy`       | SSE rollback log tail (#674)                                                                                                                                                                                                                                                          |
| `POST`       | `/studio/deploy/rollback/{env}` | Required | `deploy`       | Begin a rollback; returns a job id (#674)                                                                                                                                                                                                                                             |
| `GET`        | `/orchestrator/status`          | Required | `orchestrator` | Live daemon process status — process state, PID, uptime, and reachability (#674)                                                                                                                                                                                                      |
| `GET`        | `/orchestrator/logs`            | Required | `orchestrator` | SSE stream of live daemon log lines (#674)                                                                                                                                                                                                                                            |
| `POST`       | `/orchestrator/start`           | Required + Owner | `orchestrator` | Start the loop; transitions process state to `running` (#674); `require_owner` → `403` for every non-Owner role (#711)                                                                                                                                                          |
| `POST`       | `/orchestrator/stop`            | Required + Owner | `orchestrator` | Stop the loop; clears slots and drains a real `LoopHandle` if installed (#674); `require_owner` → `403` for every non-Owner role (#711)                                                                                                                                         |
| `GET`        | `/analytics/loops`              | Required | `orchestrator` | Per-loop health for the plan/dev/doc lanes. **v0 is dev-lane-only**: only the `dev` loop lane is populated; the `plan`/`doc` lanes are default-empty (#674)                                                                                                                           |
| `GET`        | `/analytics/slots`              | Required | `orchestrator` | Active work slots driving the Orchestrator cards. **Producerless in v0**: the socket is plumbed but no producer publishes slots, so it is always empty (#674)                                                                                                                         |
| `GET`        | `/analytics/check-runs/stream`  | Required | `orchestrator` | SSE stream of CI/check-run events. **Producerless in v0**: the stream is plumbed but has no producer, so it is always empty. Note the UI also calls a non-stream `GET /analytics/check-runs?sha=` (`TurnTimeline.tsx`, `VisualDiffPanel.tsx`) that has no backend route at all (#674) |
| `GET`        | `/pages/project`                | None     | `pages`        | Project management graph rendered as markdown                                                                                                                                                                                                                                         |
| `GET`        | `/pages/{name}`                 | None     | `pages`        | Named knowledge-base page as markdown (`prd`, `architecture`, `plan`, `strategy`, `technical`)                                                                                                                                                                                        |

### Route module layout

```
crates/sf-serve/src/routes/
├── mod.rs          — module declarations and route-table doc comment
├── auth.rs         — /api/auth/* (public — session lifecycle, register)
├── api.rs          — /api/* (auth required — app API)
├── studio.rs       — /studio/* (auth required — control-panel API: status, issues, steer) (#672)
├── orchestrator.rs — /orchestrator/*, /analytics/* (auth required — control + loop/slot analytics + SSE) (#674)
├── deploy.rs       — /studio/deploy/* (auth required — env/doctor/CI + rollback/migration logs) (#674)
├── cluster.rs      — /studio/cluster/* (auth required — cluster-status SSE for live preview) (#675)
├── ingest.rs       — /studio/docs* (auth required — knowledge ingest/docs API) (#673)
├── project.rs      — empty no-op router; the project-graph handlers it once seamed for landed in studio.rs (#672)
├── ws.rs           — WS /studio/ws (auth required — agent-chat WebSocket: chunk/done/error frames) (#687)
└── pages.rs        — /pages/* (unauthenticated for milestone 1)
```

### Notes

- `/pages/project` uses `sf_db::fetch_project_page` — a recursive CTE traversal over `nexum.project_nodes` and `nexum.links`. All other `/pages/{name}` routes use `sf_db::fetch_page_content` against `nexum.page_revisions`.
- Authentication on `/pages/*` is explicitly deferred for milestone 1; the route is expected to be reachable only from localhost during this phase.
- The `/orchestrator/status` route returns live process state read from `crates/sf-serve/src/orchestrator_state.rs` (`OrchestratorState`) rather than hardcoded nulls; `apiReachable` is `true` whenever the handler runs (the request reached the server), so the control panel's connection indicator reflects real reachability (#674).
- **Analytics producers are not wired in v0.** `/analytics/slots` and `/analytics/check-runs/stream` are plumbed sockets/streams with **no producer** — they are always empty. `/analytics/loops` carries only the `dev` lane; `plan`/`doc` are default-empty. Only `/orchestrator/status` is backed by live state today. Real producers (loop-published `WorkSlot`s with a cost field, CI/check-run events, populated `plan`/`doc` lanes) are a separate feature in this phase.
- **`/studio/cluster/events` has no health poller in v0.** The only production producer seeds cluster status **once at boot** (`crates/superfield/src/daemon_runtime.rs`); there is no periodic poller, so a mid-session status transition is not pushed in production.
- The `/studio/docs` ingest pipeline routes control-panel authoring into a dedicated **`web` corpus** — the canonical control-panel authoring corpus — kept separate from the CLI's `seed` corpus. The BERT embedder is loaded once per process via an `OnceCell` (`crates/sf-serve/src/routes/ingest.rs`) and shared across requests rather than reloaded per call.
- Static browser assets are served from a configurable directory (`CONTROL_ASSETS_DIR`) mounted at the root; the asset-serving layer is composed on top of the API router in `crates/sf-serve/src/lib.rs`.

---

## CLI — Command Surface

The `superfield` binary (`crates/superfield/src/main.rs`) is the single entrypoint for all CLI operations. Commands are parsed by `sf_cli::parse` (`crates/sf-cli/src/lib.rs`) and dispatched to the appropriate module.

### Subcommand reference

| Subcommand                                                | Module               | Requires daemon | Description                                                                        |
| --------------------------------------------------------- | -------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `superfield serve [--bind <addr>] [--session-ttl <secs>]` | `sf_serve`           | No              | Start the HTTP server in the foreground (default: `0.0.0.0:7000`)                  |
| `superfield daemon stop`                                  | `sf_cli::daemon`     | Yes             | Send SIGTERM to the daemon; waits for clean exit (max 30 s)                        |
| `superfield status`                                       | `sf_cli::daemon`     | No              | Show daemon status from `daemon.json`; exits 1 if not running                      |
| `superfield logs`                                         | `sf_cli::daemon`     | No              | Tail `daemon.log`; exits 1 if daemon not running                                   |
| `superfield page <name>`                                  | `sf_cli::page`       | No              | Fetch a named page from Nexum and print as markdown; exits 1 if daemon not running |
| `superfield garden <file...> [--workspace-id <uuid>]`     | `sf_cli::garden`     | Yes             | Ingest markdown files into the Nexum knowledge graph                               |
| `superfield repo init <name>`                             | `sf_cli::operator`   | Yes             | Create or get a Sharp repo by name                                                 |
| `superfield repo list`                                    | `sf_cli::operator`   | Yes             | List all Sharp repos                                                               |
| `superfield session issue <ws-id> <uid> <role>`           | `sf_cli::operator`   | Yes             | Issue a session token (`role`: `owner`, `requestor`, `steerer`, `collaborator`, `agent`, `auditor`, `viewer`; legacy `admin`/`member` accepted) |
| `superfield episode open <repo-id> <title>`               | `sf_cli::agent`      | Yes             | Open a new agent episode against a repo                                            |
| `superfield episode append <ep-id> <type> <json>`         | `sf_cli::agent`      | Yes             | Append an event to an existing episode                                             |
| `superfield episode finish <ep-id>`                       | `sf_cli::agent`      | Yes             | Close an episode                                                                   |
| `superfield episode list <repo-id>`                       | `sf_cli::agent`      | Yes             | List episodes for a repo                                                           |
| `superfield deploy validate <config-json>`                | `sf_deploy`          | No              | Validate a deploy target config (no I/O)                                           |
| `superfield deploy ship <config-json> <path>`             | `sf_deploy`          | No              | Deploy an artifact to a target                                                     |
| `superfield deploy rollback <record-json>`                | `sf_deploy`          | No              | Roll back target to its prior version                                              |
| `superfield deploy-env <config-json> <artifact-path>`     | `sf_cli::deploy_ops` | No              | Validate config and deploy artifact to target env via pluggable transport          |
| `superfield rollback-env <record-json>`                   | `sf_cli::deploy_ops` | No              | Roll back target to prior version using a serialised deployment record             |
| `superfield doctor <config-json>`                         | `sf_cli::deploy_ops` | No              | Run preflight validation on a target config; prints errors without performing I/O  |
| `superfield noop`                                         | (built-in)           | No              | Smoke-test — prints `superfield: ok` to stderr and exits with code 0               |

### Daemon auto-spawn

Commands that require the daemon (`garden`, `repo`, `session`, `episode`) call `connect_or_start_daemon()` automatically if the daemon is not running. The auto-spawn flow is described in full in the `## Daemon Lifecycle` section above.

Three commands are **no-spawn guards** — they exit with code 1 rather than auto-spawning if the daemon is not running: `status`, `logs`, and `page`.

### Environment variables

| Variable             | Default    | Description                                                                   |
| -------------------- | ---------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`       | (required) | Postgres connection string used by all DB-backed commands                     |
| `WORKSPACE_ID`       | (none)     | Default workspace UUID for `garden` commands (overridden by `--workspace-id`) |
| `SF_START_DAEMON`    | (unset)    | Set to `1` by the CLI when re-executing itself as the daemon                  |
| `SF_NO_DAEMON`       | (unset)    | Set to `1` to suppress `daemonize()` — foreground/container mode              |
| `SF_STARTUP_NOTIFY`  | (unset)    | Path to the startup-notify socket created by the parent CLI                   |
| `CONTROL_ASSETS_DIR` | (none)     | Directory of pre-built browser UI assets to serve at `/`                      |

### Known page names

The `superfield page <name>` command and the `GET /pages/{name}` route share the same registry of known names:

| Name           | Content source                                      |
| -------------- | --------------------------------------------------- |
| `prd`          | `nexum.page_revisions` for page name `prd`          |
| `architecture` | `nexum.page_revisions` for page name `architecture` |
| `plan`         | `nexum.page_revisions` for page name `plan`         |
| `strategy`     | `nexum.page_revisions` for page name `strategy`     |
| `technical`    | `nexum.page_revisions` for page name `technical`    |
| `project`      | Recursive CTE over `nexum.project_nodes` (special)  |

Source: `sf_db::KNOWN_PAGES` (`crates/sf-db/src/`) and `sf_db::fetch_project_page`.

---

## fastenv — Appliance Execution Environment

fastenv is the execution environment the whole appliance is built on. PRD §9 makes it a hard appliance constraint: every Superfield workload — the Forge, validation jobs, and delivered app instances — runs in fastenv, with **no general-purpose container orchestration** (no `kubectl`, no Docker daemon, no k3s in the target state). This section is an overview of that seam; the canonical detailed source is [`crates/fastenv/docs/architecture.md`](../crates/fastenv/docs/architecture.md), and the implementation lives in `crates/fastenv` (25+ modules including `container_runtime`, `boundary`, `deployment`, `host_control_plane`, and `doctor`).

### Workload isolation tiers

fastenv is a host/control-plane plus project-VM system with three nested isolation tiers:

1. **Host control plane** — the physical host runs the scheduler, Firecracker supervisor, secret broker, artifact validator, and policy monitors. It never executes project code directly. Named in code by `HostControlPlane` (current CLI routes through `LocalHostControlPlane`).
2. **Project microVM** — each project gets one Firecracker microVM as the durable security boundary: one repo / tenant / project trust domain, with its own guest kernel, project-local caches, and network policy. A compromised project must not compromise the host or another project.
3. **Agent container** — inside the VM, agent work runs in `crun` containers with overlayfs copy-on-write workspaces, private mount/PID namespaces, and restricted capabilities, so one agent cannot corrupt another's workspace or runtime state.

The host/guest split is made explicit in code through the `boundary` module: `GuestRuntime` (workspace-engine primitives, `LocalGuestRuntime`) versus `HostControlPlane`. Trust boundaries, the filesystem layout, the policy model (network, secrets, eBPF, seccomp), and the security invariants are detailed in the canonical crate doc.

### Two execution tiers: CI inner-loop and deployment

fastenv runs workloads in two distinct tiers:

- **CI inner-loop / ephemeral-workspace tier** — short-lived agent containers forked from base snapshots (`build-base`, `fork`, `exec`, `discard`), backed by the `ContainerRuntime` trait (`CrunBackend` / `YoukiBackend`).
- **Deployment tier** (#662 / #665 / #661) — a long-lived **deployment runtime** that supervises application + Postgres workloads from a manifest, letting Superfield dogfood fastenv as its own deployment container engine with no `kubectl` and no Docker daemon (dogfooding goal tracked by issue #660).

### Deployment-tier runtime

The deployment-tier entrypoint is `fastenv up --manifest <path> [--health-gate] [--health-timeout-secs N]` (`crates/fastenv/src/main.rs`, `Commands::Up`), routed through `CommandBoundary::DeploymentTier`. It drives `deployment::ManifestSupervisor` (`crates/fastenv/src/deployment.rs`) — a trait with `apply` / `health` / `down`. The production impl, `FastenvSupervisor`:

- starts workloads in dependency order (stateful workloads such as Postgres before stateless app workloads) and stops them in reverse order on `down`;
- reports per-workload `HealthStatus` via each workload's `HealthProbe`, and with `--health-gate` blocks until every workload is `Healthy` or times out;
- is idempotent on `apply` (already-running workloads skipped) and validates the manifest before starting anything.

The host-process backend behind the supervisor is `deployment::WorkloadLauncher` (`HostProcessLauncher` in production). Launchers **must not** shell out to kubectl / k3d / docker — the deployment tier runs workloads on the fastenv backend directly. `NoopSupervisor` is retained only for dry-run / parity callers.

### FastenvManifest consumer contract

The deployment tier is driven by the **engine-agnostic `FastenvManifest`**. The source of truth for the wire shape is the TypeScript artifact emitted by `packages/control-core/fastenv-translate.ts` (which translates Kubernetes manifests / docker-compose into the engine-agnostic spec); the Rust `deployment::FastenvManifest` is the consumer-side mirror, kept in sync field-for-field with JSON round-trip / contract tests on both sides. The supervisor reads each `Workload`'s `name`, `image`, `command`, `env`, `stateful`, and optional `health` probe. A `Workload` with `stateful: true` is the StatefulSet equivalent (Postgres), an in-process service registry plus host-local addressing replaces kube-proxy + CoreDNS, and `HealthProbe` is consumed by the `doctor` readiness surface.

### Backend selector and doctor

The deploy path coexists with k3s until parity. `runDeployCommand` (`packages/core/commands/deploy.ts`) takes a `backend: "k3s" | "fastenv"` option (default `k3s`; CLI flag `superfield deploy --backend fastenv`). On the fastenv backend it translates `deploy/base/*.yaml` into a `FastenvManifest`, runs `fastenv doctor` for provision, then `fastenv up --manifest … --health-gate` for deploy + readiness — and the recorded command trace contains **only `fastenv` commands** (issue #660 criterion 4). `fastenv doctor` (the subcommand that shipped with Milestone 1, see below) is the host-prerequisite preflight: it verifies KVM, CPU virtualisation flags, the Firecracker and `crun` binaries, TUN/TAP, overlayfs, and kernel version before any VM lifecycle command is attempted.

---

## Milestone 1 — Headless Gardening Appliance (completed)

Milestone 1 delivered the headless binary: daemon auto-spawn, local Postgres lifecycle, seed document ingestion, knowledge base pages projection, and project management graph. All six phase issues (#489, #490, #491, #492, #493, #494) are closed. The `fastenv` doctor subcommand (#499) shipped alongside this milestone. Refer to the individual feature PRs for implementation details; architecture content for the milestone-1 seams is documented in the sections above.

**Note:** The `crates/sf-loop` gardening loop crate is fully implemented and tested, and the daemon-loop wiring is complete (#682). On the running daemon path, `run_as_daemon` (`crates/superfield/src/main.rs`) calls `daemon_runtime::boot_loop`, which starts the loop via `GardeningLoop::start_observed` and installs the real `Arc<dyn LoopHandle>`, retiring `NoopLoopHandle`. On `SIGTERM`, `daemon_runtime::shutdown` drains the loop (then aborts as a fallback) before taking the appliance down and stopping Postgres. See §Daemon Lifecycle and §Seam: LoopHandle for the lifecycle and ordering details.
