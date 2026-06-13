# Milestone 1 — Headless Gardening Appliance

This document defines the scope and acceptance criteria for Milestone 1: a self-contained, headless process that continuously improves the company knowledge base without human intervention. It is the minimum deployable slice of the Superfield appliance substrate.

The milestone is complete when a single binary (`superfield`) can be installed on a Linux host, auto-start its Postgres dependency, and run the gardening loop indefinitely with no external scheduler, no cloud dependency, and no UI required.

---

## §4.1 — Isolation boundary

The appliance runs entirely within a single host OS process group. All mandatory dependencies (Postgres, the gardening loop, the HTTP API) are managed in-process or via subprocesses under the daemon's supervision. No external orchestrator (Kubernetes, systemd, Docker Compose) is required at runtime.

---

## §4.2 — Daemon startup handshake contract

The daemon startup handshake is the mechanism by which the CLI learns that the daemon is fully ready to serve requests. It guarantees that no CLI command proceeds before Postgres is accepting connections and all migrations have been applied.

**Participants:** CLI (spawner) and daemon (spawned binary re-executed with `SF_START_DAEMON=1`).

**Protocol:**

1. CLI pre-binds a one-shot Unix stream socket (path from `SF_STARTUP_NOTIFY` or `~/.superfield/daemon/startup_notify.sock`) and begins listening.
2. CLI spawns the daemon via re-exec, passing the socket path via `SF_STARTUP_NOTIFY`.
3. Daemon runs the full health gate:
   - Start Postgres container; poll `pg_isready` (max 60 s).
   - Run migration runner; apply all pending migrations from all component crates in dependency order.
   - Probe schema existence for all registered namespaces.
4. On success: daemon writes `daemon.json` atomically, binds `superfield.sock`, then connects to the startup-notify socket and sends `StartupResult::Ok { version, addr }`.
5. On failure: daemon sends `StartupResult::Err { reason, log_path }` and exits non-zero. `daemon.json` is never written.
6. On address conflict: daemon sends `StartupResult::AddrInUse`; CLI re-reads `daemon.json` to find the winner.

The CLI blocks on the startup-notify socket for up to 30 seconds. Expiry returns an error to the user with a pointer to `daemon.log`.

**`drain` precedes `stop`:** On graceful shutdown, the daemon calls `LoopHandle::drain()` (waits for the current gardening step to commit its cursor) before calling `PostgresProvisioner::stop()`. This ensures the knowledge-base state in Postgres is consistent when the container is stopped.

See also: `docs/architecture.md` §Daemon Lifecycle.

---

## §4.3 — Gardening command surface

The `superfield garden` subcommand exposes the gardening loop to human operators and to the CLI auto-spawn path. It is distinct from the daemon's internal loop — the CLI `garden` command is the entry point for ad-hoc runs and for the auto-spawn sequence.

**Subcommands:**

| Subcommand           | Description                                                                             |
| -------------------- | --------------------------------------------------------------------------------------- |
| `garden run`         | Execute one gardening cycle (research → reconcile → commit cursor) and exit             |
| `garden start`       | Ensure the daemon is running and the loop is active; idempotent                         |
| `garden status`      | Print the current gardening cursor, last step timestamp, and loop health                |
| `garden step <n>`    | Force-advance the cursor by `n` steps without waiting for the normal loop cadence       |

The `garden run` path is the reference implementation for the loop step contract: it must succeed from a cold start (no prior cursor) and produce an observable change in the knowledge base (at minimum, one new document block or one updated link).

See also: `crates/sf-cli/src/garden.rs` for the CLI dispatch layer.

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

The `/health` endpoint returns HTTP 200 only when:
- Postgres is accepting connections.
- All migrations are applied (verified by querying `schema_migrations`).
- The gardening loop task is running (i.e. `LoopHandle` is registered in `AppState`).

---

## §4.6 — Project graph seam

The project graph (`crates/sf-db/src/project_graph.rs`) is the typed representation of the company's project structure: issues, features, tests, and acceptance criteria as nodes in the `nexum` knowledge graph. It is the join point between the gardening loop (which writes observations) and the HTTP API (which exposes queries).

**Milestone 1 requirements for the project graph:**

1. **Issue nodes** — every GitHub issue ingested by the daemon is represented as an `Issue` node in the graph, linked to its parent `Feature` (if any) and to its `AcceptanceCriteria` child nodes.

2. **Acceptance criteria nodes** — each acceptance criterion checkbox from an issue body is parsed and stored as a typed `AcceptanceCriteria` node linked to its parent `Issue` node.

3. **Test linkage** — test functions named in the source tree are linked to the acceptance criteria they verify, enabling the gardening loop to report coverage gaps.

4. **Corpus access** — the project graph is queryable via the `nexum.corpus_access` table, which restricts graph traversal to the requesting principal's permitted corpora. No cross-tenant graph leakage is permitted.

The project graph schema is owned by the `nexum` crate and lives in the `nexum` PostgreSQL schema. See also: `crates/sf-db/src/project_graph.rs`.
