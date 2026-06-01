# Scout: Existing Service Runtimes and Shared Boundaries

**Issue:** #387
**Phase:** Rust single-binary skeleton and shared crates
**Feeds:** Rust workspace crate layout, single entrypoint, shared-concern crates

---

## Summary

This scout maps every current runtime, its entrypoint, and the shared concerns
the Rust workspace crates must provide. It is the baseline for designing the
crate boundaries before any Rust code is written.

---

## Runtime Inventory

### 1. CLI — Bun/TypeScript (`packages/cli/`)

| Property           | Current state                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Runtime**        | Bun (TypeScript, ESM)                                                                                                    |
| **Entrypoint**     | `packages/cli/bin/superfield.ts` — shebang `#!/usr/bin/env bun`; calls `runCLI(process.argv.slice(2))`                   |
| **Install target** | `superfield` binary in PATH via `bun build --compile`                                                                    |
| **Build**          | `bun run build` → single compiled binary via `bun build --compile packages/cli/bin/superfield.ts`                        |
| **Config**         | `~/.superfield/config.yaml` — users + repositories                                                                       |
| **Commands**       | `github`, `start`, `plan`, `feature`, `deploy`, `control`, `ci`, `audit`, `init`, `sync`, `doctor`, `setup-github`, etc. |
| **Process model**  | Single process; spawns agent subprocesses (`claude`, `codex`) as children via `node:child_process.spawn`                 |

**Key shared packages consumed by CLI:**

- `@superfield/core` — planning loop, dev loop, doc loop, prompts, agent spawn
- `@superfield/db` — local issue store (`lowdb` JSON file)
- `@superfield/github` — Octokit REST client, GitHub App device flow
- `@superfield/git` — `isomorphic-git` worktree management
- `@superfield/firecracker` — Firecracker VM lifecycle (CI runner)
- `@superfield/control` — Studio HTTP server (`:7000`)

---

### 2. Sharp — Node/TypeScript service (`superfield-ai/sharp`)

| Property          | Current state                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Runtime**       | Node.js (TypeScript compiled)                                                                                                                          |
| **Entrypoint**    | `apps/server/src/index.ts` — HTTP server (port from `SHARP_PORT` env)                                                                                  |
| **Process model** | Long-running HTTP service; also exports `migrate` + `seed` subcommands run via k8s Job                                                                 |
| **Database**      | Postgres (`SHARP_DSN`) — schema: `sharp`; tables: `repos`, `objects`, `refs`, `commit_paths`, `commit_metadata`, `api_keys`, `projections`, `episodes` |
| **Auth**          | Bearer tokens in `sharp.api_keys` (`scopes: read/write/operator`)                                                                                      |
| **Migration**     | `apps/server/src/migrate.ts` — versioned sequential SQL files (`schema_migrations` table, transactions)                                                |
| **Embeddings**    | No vector columns today; pgvector not installed                                                                                                        |
| **Config**        | `SHARP_DSN`, `SHARP_MIGRATE_ON_BOOT`, `SHARP_PORT`                                                                                                     |

Sharp's migration runner is the most structured of the three active services
and is the model for the Rust unified migration runner: numbered SQL files in
transactions, duplicate-detection at startup, `schema_migrations` version table.

---

### 3. Nexum — Node/TypeScript service (`superfield-ai/nexum`)

| Property          | Current state                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**       | Node.js (TypeScript compiled)                                                                                                                                                                      |
| **Entrypoint**    | `src/index.ts` (HTTP API) + background job queue worker                                                                                                                                            |
| **Process model** | Long-running HTTP service; background worker drains `nexum.job_queue`                                                                                                                              |
| **Database**      | Postgres (`DATABASE_URL`, default port 5432) — schema: `nexum`; tables: `corpora`, `documents`, `document_versions`, `blocks`, `version_blocks`, `links`, `entities`, `corpus_access`, `job_queue` |
| **Embeddings**    | `blocks.embedding vector(384)` (HNSW cosine), `links.edge_embedding vector(384)` (stub) — model: `Xenova/all-MiniLM-L6-v2`                                                                         |
| **Extensions**    | `pgcrypto`, `vector` (`pgvector/pgvector:pg16` image)                                                                                                                                              |
| **Migration**     | `src/db/migrate.ts` — idempotent SQL (`IF NOT EXISTS`); no version table; re-runs full `db/schema.sql` on boot                                                                                     |
| **Config**        | `DATABASE_URL`, `AGE_DATABASE_URL` (optional; guarded)                                                                                                                                             |
| **Auth**          | No independent auth layer; consumers pass corpus access tokens via HTTP header                                                                                                                     |

**Non-conformance (tracked):** AGE second Postgres on `:5433` is non-conforming
and is being closed by #359 (recursive CTEs on `nexum.links`).

---

### 4. FastEnv — Rust binary (`superfield-ai/fastenv`)

| Property          | Current state                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| **Runtime**       | Rust (compiled binary — not a service; invoked as a subprocess)                                              |
| **Entrypoint**    | `fastenv` binary on `$PATH` — subcommands: `fork`, `mount-path`, `discard`                                   |
| **Integration**   | `packages/cli/lib/fastenv.ts` — thin shim via `node:child_process.execFile`                                  |
| **Process model** | Short-lived subprocess per operation; p95 ≤ 100ms fork creation target                                       |
| **Mechanism**     | OCI-native COW workspace forking via containerd overlayfs; virtiofsd mounts into Firecracker VM              |
| **Config**        | `FASTENV_BINARY` (or `binaryPath` opt); base OCI image name; fork ID                                         |
| **Status**        | Binary not yet in this repo — shim in `packages/cli/lib/fastenv.ts`; daemon integration with `start` planned |

FastEnv is the only **existing Rust binary** in the current stack. It
establishes the Rust compile + release pattern the workspace will follow.

---

## Shared Concerns Inventory

| Concern            | Current handler                                                       | Location                                                                                  | Notes                                                                     |
| ------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Config**         | `~/.superfield/config.yaml` (YAML, plaintext)                         | `packages/core/config.ts`                                                                 | Users + repositories; read by CLI only; `SUPERFIELD_DEV` env flag         |
| **Database**       | `lowdb` JSON file (CLI); Postgres (Sharp, Nexum)                      | `packages/db/index.ts` (CLI), `SHARP_DSN`, `DATABASE_URL`                                 | Single Postgres instance with namespaced schemas per component (#355)     |
| **Auth**           | GitHub App device flow (CLI); bearer tokens (Sharp); none yet (Nexum) | `packages/core/github/`, `sharp.api_keys`                                                 | `auth` schema (sessions, oauth_tokens, app_installations) not yet defined |
| **Embeddings**     | `Xenova/all-MiniLM-L6-v2` ONNX — local inference                      | Nexum `src/embeddings/`; governed by `GOVERNED_EMBEDDING` const in `packages/db/index.ts` | 384-dim cosine HNSW; no embedding in Sharp or CLI today                   |
| **Migrations**     | Three independent runners                                             | Sharp: versioned SQL; Nexum: idempotent SQL; CLI: no-op shim                              | Unified runner required (#4 in §Current Gaps)                             |
| **Logging**        | Console + file (`packages/core/file-logger.ts`)                       | `packages/core/logger.ts`                                                                 | JSONL turn logs in `<CONTROL_LOG_DIR>/`                                   |
| **Agent dispatch** | `packages/core/agent.ts` — `spawn('claude'                            | 'codex')`                                                                                 | `packages/core/agent.ts`                                                  | Job registry selects backend; Firecracker VM path planned |
| **Git operations** | `isomorphic-git` (no binary)                                          | `@superfield/git` package                                                                 | Worktree creation/management                                              |
| **GitHub API**     | `@octokit/rest` (TypeScript REST client)                              | `@superfield/github` package                                                              | No system `git` or `gh` binary allowed                                    |

---

## Proposed Rust Workspace Crate Boundaries

The target is a **single compiled Rust binary** (`superfield`) that absorbs
Sharp, Nexum, FastEnv, and the CLI's orchestration core. Below is the proposed
crate layout. These are **boundaries only** — no Rust code is written in this
scout.

```
superfield-workspace/
  Cargo.toml           # workspace root
  crates/
    sharp/             # VCS core: repos, objects, refs, commits, projections
    nexum/             # Knowledge graph: corpora, documents, blocks, links, embeddings
    fastenv/           # COW workspace forking (absorb the Go/Rust binary)
    auth/              # Sessions, OAuth tokens, GitHub App tokens
    db/                # Unified migration runner; connection pool; schema namespaces
    config/            # Config file read/write (~/.superfield/config.yaml)
    embeddings/        # Xenova/all-MiniLM-L6-v2 ONNX inference wrapper
    episodes/          # Orchestrator behavioral traces (episodes schema)
    cli/               # Clap-based entrypoint; command dispatch
    api/               # HTTP API server (replaces Node http servers in Sharp and Nexum)
```

**Crate dependencies (acyclic):**

```
cli → api → sharp, nexum, fastenv, auth, episodes
api → db, config, embeddings
sharp → db
nexum → db, embeddings
auth → db, config
episodes → db
db → config
```

---

## Gaps and Risks

| #   | Gap / Risk                                              | Severity | Detail                                                                                                                                                                               |
| --- | ------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **No `auth` schema yet**                                | High     | Sharp uses `sharp.api_keys`; Nexum has no auth; CLI uses GitHub App tokens. A unified `auth` crate needs a schema design sprint.                                                     |
| 2   | **Three incompatible migration runners**                | High     | Sharp: versioned SQL. Nexum: idempotent SQL. CLI: no-op. Unified Rust runner must pick one strategy (Sharp's versioned model wins).                                                  |
| 3   | **Embedding inference in Node (Xenova ONNX)**           | Medium   | Nexum's embedding layer is Node.js/JavaScript. The Rust `embeddings` crate must replicate Xenova/all-MiniLM-L6-v2 via `ort` (ONNX Runtime for Rust) or call out to a sidecar.        |
| 4   | **FastEnv binary — language TBD**                       | Medium   | The fastenv binary is an external process today. Absorbing it into the Rust workspace means the OCI/containerd/overlayfs logic must be ported or wrapped.                            |
| 5   | **CLI runs on Bun; orchestration loop is Bun-specific** | Medium   | `bun:sqlite`, Bun's `spawn`, and Bun's module system are used throughout. A Rust rewrite of the orchestration core is a full functional port, not a thin wrapper.                    |
| 6   | **`episodes` schema not yet defined**                   | Low      | Behavioral trace tables needed by the `episodes` crate don't exist yet. Blocked until component schemas are agreed (#5 in §Current Gaps).                                            |
| 7   | **No RLS anywhere**                                     | Low      | Architecture target requires per-schema RLS. None of the three active services have it. The `auth` crate must wire `current_setting('app.current_principal_id')` across all schemas. |
| 8   | **Two pg-container.ts copies**                          | Low      | `packages/db/pg-container.ts` (unused) and `packages/control/tests/helpers/pg-container.ts` (used). Should be consolidated before Rust migration begins.                             |

---

## Integration Points for Downstream Issues

Downstream feature issues in this phase should consume:

- **`crates/db`** — unified migration runner (versioned SQL, `schema_migrations` table, transactions, idempotent); one `PgPool` shared across all crates
- **`crates/config`** — YAML config reader; environment variable overlay; `SUPERFIELD_DEV` flag
- **`crates/auth`** — `auth.sessions`, `auth.oauth_tokens`, `auth.app_installations`; bearer token validation middleware for the HTTP API
- **`crates/embeddings`** — `embed(text: &str) -> [f32; 384]`; ONNX Runtime (Rust `ort` crate); must match `Xenova/all-MiniLM-L6-v2` output exactly
- **`crates/cli`** — Clap argument parsing; single `main()`; feature flags (`--experimental`)

---

## Canonical Docs References

- `docs/architecture.md` — single-instance database, governed embedding standard, §Current Gaps
- `docs/plan.md` — Phase D-1 (Sharp), D-2 (Nexum), D-3 (FastEnv)
- `docs/roadmap.md` — Track D phase statuses
- `packages/cli/lib/fastenv.ts` — FastEnv subprocess shim
- `packages/firecracker/index.ts` — Firecracker VM lifecycle
- `packages/db/index.ts` — `GOVERNED_EMBEDDING` constant
- `superfield-ai/sharp`: `apps/server/migrations/`, `apps/server/src/migrate.ts`
- `superfield-ai/nexum`: `db/schema.sql`, `src/db/migrate.ts`, `src/embeddings/`
