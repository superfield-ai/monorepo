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

### Page-revision schema and write contract

The `nexum.page_revisions` table is the append-only store for computed knowledge-base page content produced by the gardening loop. It lives in the `nexum` PostgreSQL schema and is created by `crates/nexum/migrations/0003_page_revisions.sql`.

**DDL shape:**

```sql
CREATE TABLE IF NOT EXISTS nexum.page_revisions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID        NOT NULL,   -- tenant UUID (per-workspace RLS context)
    page_name    TEXT        NOT NULL,   -- human-readable page identifier
    content      TEXT        NOT NULL,   -- rendered Markdown / plain-text content
    provenance   TEXT        NOT NULL,   -- free-text provenance tag (URL or agent ID)
    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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

| PostgreSQL schema | Owner component | Tables (current)                                                                                                                                                           |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharp`           | Sharp           | `repos`, `objects`, `refs`, `commit_paths`, `commit_metadata`, `api_keys`, `projections`                                                                                   |
| `nexum`           | Nexum           | `corpora`, `documents`, `document_versions`, `blocks`, `version_blocks`, `links`, `entities`, `relations`, `corpus_access`, `job_queue`, `project_nodes`, `page_revisions` |
| `auth`            | Auth (shared)   | `sessions`, `oauth_tokens`, `app_installations` (to be defined during auth port)                                                                                           |
| `orchestrator`    | Orchestrator    | `gardening_cursor` (current); `episode_events`, `episode_outcomes` (to be defined; tracks agent behavioral traces)                                                         |

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

| Component    | Migration path                                                     |
| ------------ | ------------------------------------------------------------------ |
| Sharp        | `crates/sharp/migrations/`                                         |
| Nexum        | `crates/nexum/migrations/`                                         |
| Auth         | `crates/sf-auth/src/migrations/` (Rust crate)                      |
| Orchestrator | `orchestrator/migrations/` (current — `0001_gardening_cursor.sql`) |

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

The Superfield daemon is a long-running background process that owns the Postgres container, runs the gardening loop engine, and serves the HTTP API. The CLI auto-spawns it on first use and communicates with it over a Unix socket. All implementation lives in `crates/sf-cli/src/daemon.rs` and `crates/sf-serve/src/loop_handle.rs`.

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

1. Call `PostgresProvisioner::start` — start the Postgres container and wait for `pg_isready` (max 60 s).
2. Run the migration runner against the now-live instance.
3. Probe schemas (`CREATE SCHEMA IF NOT EXISTS …` idempotently).
4. Write `daemon.json` atomically (write to `.json.tmp`, then `rename`).
5. Bind `superfield.sock`.
6. Send `StartupResult` over the startup-notify socket — a 4-byte little-endian length followed by a bincode-encoded payload:

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
2. Calls `PostgresProvisioner::stop()` — flushes WAL, closes connections, and stops the container.
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

`crates/sf-db/src/provisioner.rs` defines the [`PostgresProvisioner`] trait — the interface through which the daemon owns the Postgres container lifecycle without coupling the `sf-db` crate to Docker or any specific container runtime.

| Method  | Contract                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| `start` | Ensure the Postgres container is running and `pg_isready` passes (max 60 s); idempotent — no-op if already running |
| `stop`  | Stop the container cleanly after the gardening loop has drained; idempotent — no-op if already stopped             |

The real implementation (issue #489) checks for a running container via the Docker socket, starts the container with a durable local volume if absent, and polls `pg_isready` until the health gate passes. Tests and crates that do not own the container lifecycle use [`TestProvisioner`] — a no-op that returns `Ok(())` immediately.

The daemon calls `start` during the health gate (before sending `StartupResult::Ok`) and `stop` after `LoopHandle::drain()` completes on shutdown.

### Seam: LoopHandle

`crates/sf-serve/src/loop_handle.rs` defines the [`LoopHandle`] trait — the interface through which the daemon controls the gardening loop engine (issue #491) during graceful shutdown and version-mismatch restart. The trait lives in `sf-serve` because the HTTP layer also exposes a `/orchestrator/drain` route that triggers it.

| Method  | Contract                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drain` | Signal the loop to finish its current gardening step, commit the cursor, and stop accepting new steps; resolves when the loop has stopped cleanly   |
| `abort` | Cancel any in-flight step immediately (`tokio::task::JoinHandle::abort()`); used when the daemon needs to exit without waiting for the current step |

Callers of `drain` should impose an external timeout (30 s) and fall back to `abort` if the loop does not drain in time. The trait does not enforce a timeout internally.

Tests and phase crates use [`NoopLoopHandle`] — a no-op stub that returns `Ok(())` from both methods immediately.

---

## HTTP Routes

The daemon serves a single HTTP API over TCP (default bind `0.0.0.0:7000`). All source lives in `crates/sf-serve/src/routes/`. The Unix socket at `~/.superfield/daemon/superfield.sock` is used exclusively for CLI-to-daemon RPC (startup-notify and shutdown); the HTTP routes below are served over the TCP listener.

### Authentication model

Session tokens are issued via `POST /api/auth/session` and accepted as:

- `X-Session-Token: <uuid>` request header, or
- `session` or `superfield_auth` cookie.

The auth middleware validates the token against `auth.sessions` and injects an `AuthContext` extension (workspace UUID + user UUID + role) into every request. Routes marked "Required" return `401 Unauthorized` without a valid token; routes marked "None" are unauthenticated for milestone 1 (localhost-only).

### Route table

| Method   | Path                        | Auth     | Handler module | Description                                                                       |
| -------- | --------------------------- | -------- | -------------- | --------------------------------------------------------------------------------- |
| `GET`    | `/api/auth/health`          | None     | `auth`         | Liveness probe — always returns `{"status":"ok"}`                                 |
| `POST`   | `/api/auth/session`         | None     | `auth`         | Issue a session token for a `(workspace_id, user_id, role)` triple                |
| `DELETE` | `/api/auth/session/{token}` | None     | `auth`         | Revoke an existing session token (idempotent, 204)                                |
| `POST`   | `/api/auth/register`        | None     | `auth`         | Dev/E2E bootstrap: mint a fresh workspace + user, issue a token                   |
| `GET`    | `/api/status`               | Required | `api`          | Authenticated liveness probe — echoes workspace/user/role                         |
| `GET`    | `/api/me`                   | Required | `api`          | Current principal identity + RLS session-variable verification                    |
| `GET`    | `/studio/status`            | Required | `studio`       | Studio mode flag + auth context (browser UI health check)                         |
| `GET`    | `/orchestrator/status`      | Required | `orchestrator` | Daemon process status (PID, uptime — stub in milestone 1)                         |
| `GET`    | `/pages/project`            | None     | `pages`        | Project management graph rendered as markdown                                     |
| `GET`    | `/pages/{name}`             | None     | `pages`        | Named knowledge-base page as markdown (`prd`, `architecture`, `plan`, `strategy`) |

### Route module layout

```
crates/sf-serve/src/routes/
├── mod.rs          — module declarations and route-table doc comment
├── auth.rs         — /api/auth/* (public — session lifecycle, register)
├── api.rs          — /api/* (auth required — app API)
├── studio.rs       — /studio/* (auth required — control-panel API)
├── orchestrator.rs — /orchestrator/* (auth required — orchestrator control)
└── pages.rs        — /pages/* (unauthenticated for milestone 1)
```

### Notes

- `/pages/project` uses `sf_db::fetch_project_page` — a recursive CTE traversal over `nexum.project_nodes` and `nexum.links`. All other `/pages/{name}` routes use `sf_db::fetch_page_content` against `nexum.page_revisions`.
- Authentication on `/pages/*` is explicitly deferred for milestone 1; the route is expected to be reachable only from localhost during this phase.
- The `/orchestrator/status` route returns a minimal stub (PID = null, apiReachable = false) until the gardening-loop process manager is ported (issue #491).
- Static browser assets are served from a configurable directory (`CONTROL_ASSETS_DIR`) mounted at the root; the asset-serving layer is composed on top of the API router in `crates/sf-serve/src/lib.rs`.

---

## CLI — Command Surface

The `superfield` binary (`crates/superfield/src/main.rs`) is the single entrypoint for all CLI operations. Commands are parsed by `sf_cli::parse` (`crates/sf-cli/src/lib.rs`) and dispatched to the appropriate module.

### Subcommand reference

| Subcommand                                                | Module             | Requires daemon | Description                                                       |
| --------------------------------------------------------- | ------------------ | --------------- | ----------------------------------------------------------------- |
| `superfield serve [--bind <addr>] [--session-ttl <secs>]` | `sf_serve`         | No              | Start the HTTP server in the foreground (default: `0.0.0.0:7000`) |
| `superfield daemon stop`                                  | `sf_cli::daemon`   | Yes             | Send SIGTERM to the daemon; waits for clean exit (max 30 s)       |
| `superfield status`                                       | `sf_cli::daemon`   | No              | Show daemon status from `daemon.json`; exits 1 if not running     |
| `superfield logs`                                         | `sf_cli::daemon`   | No              | Tail `daemon.log`; exits 1 if daemon not running                  |
| `superfield page <name>`                                  | `sf_cli::page`     | Yes             | Fetch a named page from Nexum and print as markdown               |
| `superfield garden <file...> [--workspace-id <uuid>]`     | `sf_cli::garden`   | Yes             | Ingest markdown files into the Nexum knowledge graph              |
| `superfield repo init <name>`                             | `sf_cli::operator` | Yes             | Create or get a Sharp repo by name                                |
| `superfield repo list`                                    | `sf_cli::operator` | Yes             | List all Sharp repos                                              |
| `superfield session issue <ws-id> <uid> <role>`           | `sf_cli::operator` | Yes             | Issue a session token (`role`: `admin`, `member`, `viewer`)       |
| `superfield episode open <repo-id> <title>`               | `sf_cli::agent`    | Yes             | Open a new agent episode against a repo                           |
| `superfield episode append <ep-id> <type> <json>`         | `sf_cli::agent`    | Yes             | Append an event to an existing episode                            |
| `superfield episode finish <ep-id>`                       | `sf_cli::agent`    | Yes             | Close an episode                                                  |
| `superfield episode list <repo-id>`                       | `sf_cli::agent`    | Yes             | List episodes for a repo                                          |
| `superfield deploy validate <config-json>`                | `sf_deploy`        | No              | Validate a deploy target config (no I/O)                          |
| `superfield deploy ship <config-json> <path>`             | `sf_deploy`        | No              | Deploy an artifact to a target                                    |
| `superfield deploy rollback <record-json>`                | `sf_deploy`        | No              | Roll back target to its prior version                             |

### Daemon auto-spawn

Commands that require the daemon (`page`, `garden`, `repo`, `session`, `episode`) call `connect_or_start_daemon()` automatically if the daemon is not running. The auto-spawn flow is described in full in the `## Daemon Lifecycle` section above.

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
| `project`      | Recursive CTE over `nexum.project_nodes` (special)  |

Source: `sf_db::KNOWN_PAGES` (`crates/sf-db/src/`) and `sf_db::fetch_project_page`.

---

## Nexum — Page Revision Schema

The `nexum.page_revisions` table is the append-only store for computed knowledge-base page content produced by the gardening loop. It lives in the `nexum` PostgreSQL schema and is created by `crates/nexum/migrations/0003_page_revisions.sql`.

### DDL shape

```sql
CREATE TABLE IF NOT EXISTS nexum.page_revisions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID        NOT NULL REFERENCES public.workspaces(id),
    page_name    TEXT        NOT NULL,
    content      TEXT        NOT NULL,
    provenance   TEXT        NOT NULL DEFAULT '',
    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_revisions_workspace_page_idx
    ON nexum.page_revisions (workspace_id, page_name, ingested_at DESC);
```

### Write contract

The single write entrypoint is `insert_page_revision` in `crates/sf-db/src/page_revision.rs`. Callers supply `workspace_id`, `page_name`, `content`, and `provenance`; the function inserts one row and returns `Ok(())`.

### Idempotency (append-only, no update)

Each invocation appends a new revision row — there is no `ON CONFLICT DO UPDATE`. Readers select the latest revision for a `(workspace_id, page_name)` pair by ordering on `ingested_at DESC`. Re-running the gardening step does not corrupt history — it appends a newer row that becomes the effective current revision.

### Migration prerequisite

The `nexum.page_revisions` table must exist before `insert_page_revision` is called. The daemon's health gate applies all component migrations (including `0003_page_revisions.sql`) before sending `StartupResult::Ok`, so the table is guaranteed to exist for any in-process caller.

See also: `crates/sf-db/src/page_revision.rs` (write contract implementation).

---

## Milestone 1 — Headless Gardening Appliance (completed)

Milestone 1 delivered the headless binary: daemon auto-spawn, Postgres container lifecycle, seed document ingestion, continuous gardening loop, knowledge base pages projection, and project management graph. All six phase issues (#489, #490, #491, #492, #493, #494) are closed. The `fastenv` doctor subcommand (#499) shipped alongside this milestone. Refer to the individual feature PRs for implementation details; architecture content for the milestone-1 seams is documented in the sections above.
