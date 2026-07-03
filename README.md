# Superfield

**Superfield is a software-factory appliance — the Forge of [`docs/prd.md`](docs/prd.md): a self-contained system a company installs on infrastructure it controls, where AI agents run a continuous autonomous loop — planning, coding, testing, reviewing, deploying.**

It is built for companies with more than $10M in annual revenue that do not hire full-time engineers — a skeletal technical staff with a technical lead under whatever title (CIO, CTO, COO). The operational bar is IT-admin grade: administrable by the generalist who runs the company firewall and the Microsoft 365 tenant. Humans steer intent and approve **outcomes** — behavior demonstrations of completed changes, never code diffs; agents do the work.

> **Terminology.** Earlier drafts called Superfield an "Agent IDE." That term is retired; this README uses the PRD's vocabulary — **Forge** (the appliance), **Studio** (the control panel). See the [Glossary](#glossary).

---

## Phase 1 — The Appliance

Superfield ships as a self-contained **appliance**: a single `superfield` binary that a company installs on infrastructure it controls — no cloud account and **no GitHub** (see `docs/technical-requirements.md`). The target install experience is an on-prem NAS/firewall appliance: a signed, checksummed release an IT generalist runs and administers through Studio. That installer is a **planned requirement, not yet shipped** — today the binary is built from source via the developer path below. The binary is the Forge described in [`docs/prd.md`](docs/prd.md): the knowledge base, project management, and CI orchestration in one process, backed by one store.

| Layer              | What it does                                                                                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Daemon**         | The binary re-executes itself as a supervised daemon: it provisions and health-gates a local PostgreSQL, runs migrations, then binds the HTTP serving layer. Managed with `superfield status` / `logs` / `daemon stop`.                                                                         |
| **Gardening loop** | An autonomous `tokio` loop (`sf-loop`) that continuously researches, reconciles, and derives the company brain — strategy → PRD → technical → architecture → plan → project graph → code-change proposals — resuming from a durable cursor.                                                     |
| **Company brain**  | One PostgreSQL store unifying the knowledge base, embeddings, project graph, and transactional record; its knowledge-graph component is **Nexum** (`crates/nexum`). Knowledge pages (`prd`, `architecture`, `plan`, `strategy`, `technical`, `project`) are read with `superfield page <name>`. |
| **fastenv**        | The appliance's own execution environment (`crates/fastenv`) for isolated workloads — no Kubernetes, Docker daemon, or k3s in the target state (`docs/prd.md` §9).                                                                                                                              |

> **Retired prototype.** An earlier TypeScript/Bun orchestrator drove the loop over GitHub issues/PRs and deployed via k3s. It was scaffolding to prove the loop and is **not** part of the appliance; GitHub is never required. Its internals remain only in git history and the `packages/*` tree, and are not documented as appliance architecture (`docs/architecture.md`).

## Phase 2 — Self-Improving App Platforms _(R&D)_

The retired prototype leaned on Git and GitHub as its delivery plane. Phase 2 is the R&D successor: it replaces that plane with infrastructure purpose-built for agent iteration speed (the appliance itself already requires no GitHub — see Phase 1):

| Component   | Repo                                                            | Role                                                                                                  |
| ----------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Sharp**   | [`superfield-ai/sharp`](https://github.com/superfield-ai/sharp) | Agent-native VCS, backwards-compatible with Git. Branching-free change tracking at sub-second cadence |
| **FastEnv** | _(in active development — `crates/fastenv`)_                    | Ultrafast container forking for sub-second CI inner loops — a fresh isolated env per test run         |

> **Nexum** names exactly one thing: the knowledge-graph component of the company brain inside the appliance (see Phase 1 and the [Glossary](#glossary)). An earlier Phase-2 use of the name for an external synthetic-corpus repo is retired (2026-07-02): nothing learned inside a customer's brain crosses into another customer's — there is no cross-customer flywheel. (Sovereignty is directional positioning, not an absolute: data-at-rest stays on-prem, while inference transits the model API via the partner — decided 2026-07-03.)

**The end goal: self-improving app platforms** — applications that continuously audit and improve themselves, with Superfield as the safe, observable, reversible runtime for autonomous self-modification.

## Glossary

| Term                           | Meaning                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Forge / appliance / daemon** | One thing: the installed `superfield` binary. "Forge" is the PRD's name for it, "appliance" its delivery form, the daemon its supervised runtime.                                                                                                                                                                                 |
| **Studio / control panel**     | One surface: the web control panel. The PRD says "control panel"; the routes say Studio. Its primary mode (decided 2026-07-02) is batch review of completed candidate outcomes, not a live steering cockpit.                                                                                                                      |
| **Nexum**                      | The knowledge-graph component of the company brain (`crates/nexum`): documents, blocks, embeddings, page revisions. The brain is broader than Nexum — source code, change history, and validation results live in the `sharp`/`forge` schemas. Nexum has no other current meaning, and no data crosses between customers' brains. |
| **Gardening loop**             | The autonomous loop (`crates/sf-loop`) that derives and maintains the brain.                                                                                                                                                                                                                                                      |
| **Orchestrator**               | In the PRD, the CI job **orchestrator seed app** — the PRD's only bare use of the term; every other use must be qualified. Qualified uses here: the `orchestrator` schema and routes (daemon control); the retired TypeScript orchestrator (the prototype); the root `orchestrator/` directory, a leftover from it.               |
| **Sharp**                      | The agent-native, Git-backwards-compatible VCS (`crates/sharp`). Continuous export — source as a plain git tree plus a portable brain schema — is a ratified product guarantee (2026-07-02).                                                                                                                                      |

---

## Requirements (developer build)

These are the requirements for **building from source — the developer path**, not the customer install story. Customers get a signed, checksummed release installable by an IT generalist; that installer is planned and does not exist yet.

- A Linux host you control.
- A Rust toolchain (see `rust-version` in `Cargo.toml`) to build the binary.
- PostgreSQL — the daemon provisions and supervises a **local** instance automatically; set `DATABASE_URL` to point at an external/managed Postgres instead.

No GitHub account, GitHub App, or network access to github.com is required (`docs/technical-requirements.md`).

## Install (developer path)

Build the single `superfield` binary from the workspace:

```bash
cargo build --release
```

The binary lands at `target/release/superfield`.

---

## Running the appliance

The CLI below is a **developer and agent surface**. Per the plan of record, customer administration — credentials, approvals, backup, restore, rollback — belongs in Studio at IT-admin grade; those Studio workflows are planned, not yet shipped.

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
