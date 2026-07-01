# Superfield

**Superfield is an Agent Integrated Development Environment (Agent IDE).**

Where a traditional IDE helps a human write code, Superfield runs a continuous autonomous loop — planning, coding, testing, reviewing, deploying — driven entirely by AI agents. The developer steers intent; agents do the work.

---

## Phase 1 — The Appliance

Superfield ships as a self-contained **appliance**: a single `superfield` binary that a company installs on infrastructure it controls. It arrives working — no external toolchain, no cloud account, and **no GitHub** (see `docs/technical-requirements.md`). The binary is the Forge described in [`docs/prd.md`](docs/prd.md): the knowledge base, project management, and CI orchestration in one process, backed by one store.

| Layer                       | What it does                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Daemon**                  | The binary re-executes itself as a supervised daemon: it provisions and health-gates a local PostgreSQL, runs migrations, then binds the HTTP serving layer. Managed with `superfield status` / `logs` / `daemon stop`.        |
| **Gardening loop**          | An autonomous `tokio` loop (`sf-loop`) that continuously researches, reconciles, and derives the company brain — strategy → PRD → technical → architecture → plan → project graph → code-change proposals — resuming from a durable cursor. |
| **Company brain (Nexum)**   | One PostgreSQL store unifying the knowledge base, embeddings, project graph, and transactional record. Knowledge pages (`prd`, `architecture`, `plan`, `strategy`, `technical`, `project`) are read with `superfield page <name>`. |
| **fastenv**                 | The appliance's own execution environment (`crates/fastenv`) for isolated workloads — no Kubernetes, Docker daemon, or k3s in the target state (`docs/prd.md` §9).                                                              |

> **Retired prototype.** An earlier TypeScript/Bun orchestrator drove the loop over GitHub issues/PRs and deployed via k3s. It was scaffolding to prove the loop and is **not** part of the appliance; GitHub is never required. Its internals remain only in git history and the `packages/*` tree, and are not documented as appliance architecture (`docs/architecture.md`).

## Phase 2 — Self-Improving App Platforms _(R&D)_

The retired prototype leaned on Git and GitHub as its delivery plane. Phase 2 is the R&D successor: it replaces that plane with infrastructure purpose-built for agent iteration speed (the appliance itself already requires no GitHub — see Phase 1):

| Component   | Repo                                                            | Role                                                                                                       |
| ----------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Sharp**   | [`superfield-ai/sharp`](https://github.com/superfield-ai/sharp) | Agent-native VCS, backwards-compatible with Git. Branching-free change tracking at sub-second cadence      |
| **Nexum**   | [`superfield-ai/nexum`](https://github.com/superfield-ai/nexum) | Self-improving synthetic corpus — living curriculum that agents refine as they work, improving future runs |
| **FastEnv** | _(in active development — `crates/fastenv`)_                    | Ultrafast container forking for sub-second CI inner loops — a fresh isolated env per test run              |

**The end goal: self-improving app platforms** — applications that continuously audit and improve themselves, with Superfield as the safe, observable, reversible runtime for autonomous self-modification.

---

## Requirements

- A Linux host you control.
- A Rust toolchain (see `rust-version` in `Cargo.toml`) to build the binary.
- PostgreSQL — the daemon provisions and supervises a **local** instance automatically; set `DATABASE_URL` to point at an external/managed Postgres instead.

No GitHub account, GitHub App, or network access to github.com is required (`docs/technical-requirements.md`).

## Install

Build the single `superfield` binary from the workspace:

```bash
cargo build --release
```

The binary lands at `target/release/superfield`.

---

## Running the appliance

Most commands auto-spawn the daemon on first use (which health-gates Postgres and starts the gardening loop). You can also drive it explicitly.

```bash
superfield serve [--bind <addr>]   # start the HTTP serving layer (default 0.0.0.0:7000)
superfield status                  # show daemon status (exits 1 if not running)
superfield logs                    # tail the daemon log
superfield daemon stop             # graceful shutdown (drains loop, stops Postgres)
```

The HTTP server binds only after the health gate passes (Postgres up, migrations applied). See `docs/milestone-1.md` and `docs/architecture.md` §Daemon Lifecycle.

## Knowledge base and project

```bash
superfield garden <file...> [--workspace-id <uuid>]   # ingest markdown into the Nexum knowledge graph
superfield page <name>                                # print a knowledge page as markdown
                                                      # name: prd | architecture | plan | strategy | technical | project
```

## Repos, sessions, and episodes

```bash
superfield repo init <name>                     # create or get a Sharp repo
superfield repo list                            # list all repos
superfield session issue <ws-id> <uid> <role>   # issue a session token
superfield episode open <repo-id> <title>       # open an agent episode
superfield episode append <ep-id> <type> <json> # append an event to an episode
superfield episode finish <ep-id>               # close an episode
superfield episode list <repo-id>               # list episodes for a repo
```

## Deploy

```bash
superfield deploy validate <config-json>            # validate a target config (no I/O)
superfield deploy ship <config-json> <path>         # ship a build to a target
superfield deploy rollback <record-json>            # roll back to the prior version
superfield deploy-env <config-json> <artifact-path> # deploy artifact via pluggable transport
superfield rollback-env <record-json>               # roll back using a deployment record
superfield doctor <config-json>                     # preflight validation on a target config
```

---

## Development

```bash
cargo build
cargo test
cargo clippy --all-targets
```

## Structure

```
crates/
  superfield/    Single-binary entrypoint — CLI dispatch + daemon runtime
  sf-cli/        CLI command parsing and dispatch (operator + agent + garden + page)
  sf-serve/      HTTP serving layer and app state
  sf-loop/       Autonomous gardening loop engine
  sf-db/         Shared schema, migrations, page registry, and project graph
  sf-auth/       Sessions, roles, and access control
  nexum/         Knowledge graph — documents, blocks, embeddings, page revisions
  sharp/         Agent-native VCS and semantic-merge gate
  fastenv/       Appliance execution environment (workload isolation, no k3s)
  sf-deploy/     Deploy target validation and transports
  sf-connector/  Read connectors to external systems of record
  sf-notify/     Notification delivery
  sf-eval/       Evaluation harness
docs/
  prd.md            Canonical product requirements
  technical-requirements.md  Required software, derived from the vision
  architecture.md   Technical design of the appliance substrate
```
