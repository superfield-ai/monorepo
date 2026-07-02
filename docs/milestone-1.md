# Milestone 1 — Headless Gardening Appliance

This document defines the scope and acceptance criteria for Milestone 1: a self-contained, headless process that continuously improves the company knowledge base without human intervention. It is the minimum deployable slice of the Superfield appliance substrate.

The milestone is complete when a single binary (`superfield`) can be installed on a Linux host, auto-start its Postgres dependency, and run the gardening loop indefinitely with no external scheduler, no cloud dependency, and no UI required.

---

## §4.1 — Isolation boundary

The appliance runs entirely within a single host OS process group. All mandatory dependencies (Postgres, the gardening loop, the HTTP API) are managed in-process or via subprocesses under the daemon's supervision. No external orchestrator (Kubernetes, systemd, Docker Compose) is required at runtime.

Postgres in particular is **not** a container: `LocalPostgresProvisioner` runs `initdb` into `~/.superfield/daemon/postgres` and starts the instance as a daemon-supervised subprocess via `pg_ctl` — no Docker, no root, no container runtime (see `docs/architecture.md` §Seam: PostgresProvisioner). The host prerequisite, stated once here: a Postgres server installation whose `initdb`/`pg_ctl` binaries are on `PATH` or in a Debian/Ubuntu versioned bin directory (`/usr/lib/postgresql/<ver>/bin`).

---

## §4.2 — Daemon startup handshake contract

The daemon startup handshake is the mechanism by which the CLI learns that the daemon is fully ready to serve requests. It guarantees that no CLI command proceeds before Postgres is accepting connections and all migrations have been applied.

**Participants:** CLI (spawner) and daemon (spawned binary re-executed with `SF_START_DAEMON=1`).

**Protocol:**

1. CLI pre-binds a one-shot Unix stream socket (path from `SF_STARTUP_NOTIFY` or `~/.superfield/daemon/startup_notify.sock`) and begins listening.
2. CLI spawns the daemon via re-exec, passing the socket path via `SF_STARTUP_NOTIFY`.
3. Daemon runs the full health gate:
   - Start the daemon-managed Postgres instance (a `LocalPostgresProvisioner` subprocess — see §4.1); poll `pg_isready` (max 60 s).
   - Run migration runner; apply all pending migrations from all component crates in dependency order.
   - Probe schema existence for all registered namespaces.
4. On success: daemon writes `daemon.json` atomically, binds `superfield.sock`, then connects to the startup-notify socket and sends `StartupResult::Ok { version, addr }`.
5. On failure: daemon sends `StartupResult::Err { reason, log_path }` and exits non-zero. `daemon.json` is never written.
6. On address conflict: daemon sends `StartupResult::AddrInUse`; CLI re-reads `daemon.json` to find the winner.

The CLI blocks on the startup-notify socket for up to 30 seconds. Expiry returns an error to the user with a pointer to `daemon.log`.

**`drain` precedes `stop`:** On graceful shutdown, the daemon calls `LoopHandle::drain()` (waits for the current gardening step to commit its cursor) before calling `PostgresProvisioner::stop()`. This ensures the knowledge-base state in Postgres is consistent when the Postgres instance is stopped.

See also: `docs/architecture.md` §Daemon Lifecycle.

---

## §4.3 — Gardening command surface

The gardening loop is **not** driven by human-invoked run/step subcommands. The shipped `superfield garden` surface is a single ingest verb, and the run/step lifecycle lives entirely inside the daemon-supervised loop engine.

**Seed ingestion — `garden <file...>`:**

```text
superfield garden <file1> [file2...] [--workspace-id <uuid>]
```

`garden` reads one or more markdown files and ingests them into the Nexum knowledge graph as versioned documents (`garden_ingest` → `nexum.documents`/`blocks`, deduped by content hash). It is idempotent by canonical source path. This is how the company brain is seeded; it does not itself advance the gardening cursor. This matches `docs/architecture.md`, which documents `garden <file...>` as "Ingest markdown files into the Nexum knowledge graph."

**Run/step lifecycle — the daemon loop engine:**

The research → reconcile → commit-cursor cycle is executed continuously by the `sf-loop` engine as a `tokio` task the daemon supervises (see §4.4). It resumes from its persisted cursor on daemon boot and advances on its own cadence — there is no per-step human command. Operators observe and control it through the daemon:

- `superfield status` — daemon (and therefore loop) liveness.
- `superfield logs` — tail the daemon log, including the loop's per-step activity.
- `superfield daemon stop` — graceful shutdown that drains the current step and commits the cursor before Postgres stops.

The loop-step contract (cold start with no prior cursor, at-least-once commit, observable knowledge-base change per step) is the responsibility of the loop engine, defined in §4.4.

See also: `crates/sf-cli/src/garden.rs` for the `garden` ingest dispatch and `crates/sf-loop/src/lib.rs` for the loop engine.

---

## §4.4 — Loop engine continuity contract

The gardening loop engine runs as a `tokio` task supervised by the daemon. It must satisfy the following continuity properties:

1. **Resumable** — the loop stores its cursor in `orchestrator.gardening_cursor` (Postgres). On restart (including after a crash or daemon upgrade), the loop resumes from the last committed cursor position. No step is skipped and no step is double-applied.

2. **At-least-once delivery** — each gardening step is committed to the cursor only after its side effects (knowledge-base writes) are durably flushed to Postgres. A step that fails mid-execution leaves the cursor unchanged; the loop retries the step on the next iteration.

3. **Drain signal** — the loop exposes a `LoopHandle::drain()` method (see `crates/sf-serve/src/loop_handle.rs`). On receiving the drain signal, the loop finishes its current step, commits the cursor, and stops accepting new steps. The daemon calls this before stopping Postgres to ensure a clean shutdown.

4. **Abort signal** — `LoopHandle::abort()` cancels any in-flight step immediately (via `tokio::task::JoinHandle::abort()`). Used when the daemon needs to exit without waiting for the current step (e.g. forced restart, SIGKILL imminent).

5. **No busy-loop** — between steps, the loop waits for a configurable inter-step delay (default 5 s) to avoid saturating the Postgres connection pool or the embedding inference path.

See also: `crates/sf-loop/src/lib.rs` for the loop engine implementation.

---

## §4.5 — HTTP API availability gate

The HTTP API (`superfield serve`) must not accept external connections before the health gate passes. The serving layer binds the listener socket only after `StartupResult::Ok` has been sent over the startup-notify socket. This prevents race conditions where a client connects before migrations have run.

The `/health` endpoint itself is a bare, unauthenticated liveness probe — it returns `{"status":"ok"}` and performs no per-request checks (`docs/architecture.md` §HTTP Routes). The readiness guarantee lives in the boot gate, not in the endpoint: because the listener binds only after the health-gated boot completes, any reachable `/health` implies that at boot:

- Postgres was accepting connections.
- All migrations were applied (verified by querying `schema_migrations`).
- The gardening loop task was running (i.e. `LoopHandle` registered in `AppState`).

Monitoring that needs readiness semantics should treat listener reachability as the signal; the response body adds no further guarantee.

---

## §4.6 — Project graph seam

The project graph (`crates/sf-db/src/project_graph.rs`) is the typed representation of the company's project structure: issues, features, tests, and acceptance criteria as nodes in the `nexum` knowledge graph. It is the join point between the gardening loop (which writes observations) and the HTTP API (which exposes queries).

**Milestone 1 requirements for the project graph:**

1. **Feature and Issue nodes** — the appliance daemon does **not** ingest GitHub issues (GitHub is never required — `docs/technical-requirements.md`). The `ProjectGraphDerive` gardening step derives `Feature` and `Issue` nodes from the `plan`/`prd`/`strategy` knowledge pages (`docs/architecture.md`), writing them to `nexum.project_nodes` via `insert_feature`/`insert_issue`.

2. **Acceptance criterion nodes** — *delivered as schema only.* The typed `AcceptanceCriterion` node and the `project:feature_has_acceptance_criterion` edge exist (`crates/sf-db/src/project_graph.rs`, `insert_acceptance_criterion`), but no acceptance-criteria data is attached to any Feature and nothing gates on it. Making criteria populated, executable, and gating is owned by `docs/eval-design.md` §"The missing primitive: executable acceptance criteria".

3. **Test linkage** — *deferred.* Linking test functions named in the source tree to the acceptance criteria they verify (enabling the gardening loop to report coverage gaps) depends on populated acceptance criteria and is deferred with them; ownership likewise sits with `docs/eval-design.md` §"The missing primitive".

4. **Corpus access** — the project graph is queryable via the `nexum.corpus_access` table, which restricts graph traversal to the requesting principal's permitted corpora. No cross-tenant graph leakage is permitted.

The project graph schema is owned by the `nexum` crate and lives in the `nexum` PostgreSQL schema. See also: `crates/sf-db/src/project_graph.rs`.
