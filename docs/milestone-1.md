# Milestone 1 — Headless Gardening Appliance

> Companion to [`prd.md`](./prd.md) and [`architecture.md`](./architecture.md). The PRD describes the end state; this document defines the first demonstrable milestone on the way there and how to achieve it with the components that exist today. Planning source of truth remains Plan issue #199.

## 1. The milestone, in one paragraph

A user installs nothing but the Superfield CLI. The first CLI invocation starts the appliance daemon if it is not already running; the daemon brings up (or connects to) the Postgres substrate, which runs in a container with a durable local volume so a daemon restart loses no data. The user submits exactly two seed documents — `company-background.md` and `prd.md` — and from that input alone the appliance begins **gardening** the knowledge base under the Superfield Blueprint: researching company strategy on the web, reconciling findings against the PRD, researching technical implementations and constraints, proposing an architecture, and proposing an implementation plan. Each pass of the gardening loop improves and reconciles all of these topics holistically. The loop runs continuously and independently of the user until the daemon is killed. At any time, the user queries knowledge base **pages** from the CLI — the PRD page, the architecture page, the project management page — and gets a current textual rendering. The milestone is headless by design; a web app serving the same queries is a later milestone.

## 2. Demo script

The milestone is done when this demo runs end to end on a clean machine:

1. `superfield garden ./company-background.md ./prd.md` — no daemon is running yet. The CLI detects this, starts the daemon, the daemon starts the Postgres container (durable volume at a well-known local path), runs migrations, ingests both documents into the knowledge base, and starts the gardening loop. The CLI returns; the loop keeps running in the background.
2. Minutes later: `superfield page prd` — prints the current PRD page, already revised by reconciliation against web research findings.
3. `superfield page architecture` — prints the proposed architecture page derived from the PRD and technical-constraint research.
4. `superfield page project` — prints the project management view: issues with their features, testing plans, and acceptance criteria, including live transactional status (which items are open, in progress, validated).
5. `superfield logs` (or equivalent) — tails the daemon's structured logs of the background agents: which gardening step is running, what each agent found, what it changed.
6. Kill the daemon. Restart it with any CLI call. All knowledge base state and project management state survive — the Postgres volume is durable. The gardening loop resumes from the brain alone (no in-process state is load-bearing).

## 3. Scope

### In scope

**CLI and daemon lifecycle**

- A headless CLI (`crates/superfield` binary, command surface in `crates/sf-cli`) whose every command transparently starts the daemon when it is not running (lock/PID file or socket probe; no separate `daemon start` step required, though one may exist).
- The daemon owns Postgres readiness: start the container if absent, wait for accepting connections, run the unified migration runner (#428), and only then report healthy. Postgres runs containerised with a durable named volume so demo restarts lose no data.
- The daemon emits structured logs of agent activity to a local log path the CLI can tail.

**Seed ingestion**

- Accept exactly two markdown seeds: `company-background.md` and `prd.md`. Ingest them as versioned documents in the Nexum knowledge graph (`nexum` schema: `documents`, `document_versions`, `blocks`, `links`).

**The gardening loop**

- A continuously running loop, independent of CLI calls, that on each pass advances and reconciles five topics under Blueprint rules:
  1. **Company strategy research** — web research on the company; findings written to the knowledge base as sourced blocks.
  2. **PRD reconciliation** — diff research findings against the seeded `prd.md`; revise the PRD page, preserving the user's stated intent and recording provenance for every change.
  3. **Technical research** — implementations and constraints relevant to the PRD (libraries, substrates, integration limits).
  4. **Architecture proposal** — a coherent architecture page derived from the PRD and the technical research.
  5. **Implementation plan proposal** — a phased plan page derived from the architecture.
- **Holistic reconciliation:** each pass re-reads all five topics and propagates changes across them (a strategy finding that invalidates a PRD claim must ripple into the architecture and plan pages). No topic is ever final; pages are continuously revised, never re-authored.
- The loop is stateless and resumable from the brain alone (technical-requirements §2.4): a watermark/cursor in Postgres records loop progress; killing and restarting the daemon resumes gardening with zero lost work.

**Knowledge base pages**

- A **page** is a named, queryable rendering over the knowledge graph — at minimum: `prd`, `architecture`, `plan`, `strategy`, `project`. The CLI fetches a page and prints a textual (markdown) representation. Pages are projections of graph state, not stored documents — querying twice after a gardening pass shows the newer state.

**Project management view**

- The daemon maintains a project management view as a blend of document and transactional data in the property-graph form the Blueprint prescribes:
  - Every pull request links to exactly **one issue** (one issue per PR).
  - An issue carries **multiple features**, a testing plan with **multiple required tests**, and **multiple acceptance criteria** — each as first-class graph records with edges to the issue, not text in a body.
- `superfield page project` renders this graph as text, including up-to-date transactional status (issue states, validation outcomes) at query time.

### Out of scope (deferred)

- Any web app or browser UI for page queries (explicitly a future milestone; the milestone is headless).
- Code generation, PR creation, merging, or deployment — gardening ends at the proposed implementation plan; the dev loop is a later milestone.
- Multi-workspace / multi-tenant operation; one workspace is sufficient for the demo (RLS substrate from #429/#430 may exist beneath it but is not exercised).
- Production-grade Postgres replication/backup (#459); the durable local volume is the demo-grade durability story.
- Fine-tuned Blueprint model; the compiled YAML rule graph (`blueprint/rules/graph.yaml`) is the binding rule source for this milestone.
- Signal capture from delivered apps — there are no delivered apps yet.

## 4. How to achieve it

The work decomposes into six workstreams. The substrate workstream is the gate; the rest parallelize once it lands, consistent with Plan #199's phase order.

### 4.1 Substrate (gates everything) — mostly existing Plan work

The milestone sits directly on **Substrate foundations** (Plan #199, scout gate #426 — completed): one Postgres instance, namespaced schemas per `docs/adr-schema-boundary.md`, the unified migration runner (#428), and graph traversal via recursive CTEs over `nexum.links` (#431 removed the second-Postgres AGE path) so the property-graph project management view needs no second store. New for this milestone: daemon-managed container lifecycle (start container, durable volume, health gate) layered on `crates/sf-db`.

### 4.2 Daemon and CLI lifecycle

Extend the `superfield` binary into a daemonizable process hosting `sf-serve` plus the gardening loop. CLI commands probe for the daemon (socket or PID file) and spawn it when absent, then talk to it over the local API `sf-serve` already provides. Deliverables: daemon-if-needed startup path, `page <name>` command, `logs` command, clean shutdown that drains the loop.

### 4.3 Seed ingestion into Nexum

A small ingestion path mapping the two seed markdown files into `nexum.documents` / `document_versions` / `blocks`, with `links` connecting PRD claims to the blocks that support or contradict them. This is the first real write-path exercise of the Nexum schema in the shared instance (Plan phase: Nexum schema migration, #441, supplies the substrate).

### 4.4 The gardening loop engine

The loop engine is the largest new build: a scheduler in the daemon that runs gardening passes, each pass invoking agent steps (strategy research → PRD reconcile → tech research → architecture → plan → holistic reconcile) with results written to the graph and a cursor advanced per step. Hard requirements: resumable from Postgres alone; every page revision records provenance (which agent, which sources, which rule); Blueprint rule graph consulted as a binding input when proposing architecture and plan content. Web research uses the agent runtime's search/fetch tools; LLM access stays behind the governed vendor boundary (technical-requirements §2.5).

### 4.5 Pages — projections over the graph

A page registry in the daemon: each page is a query + renderer over Nexum (and the project graph) producing markdown. Start with `prd`, `architecture`, `plan`, `strategy`, `project`. This is deliberately the seam where the future web app attaches: the web milestone reuses the same projections over HTTP, so nothing here is throwaway.

### 4.6 Project management graph

Model issue / feature / required-test / acceptance-criterion / pull-request as typed nodes and edges in the property graph (typed rows in `nexum.links` traversed via recursive CTEs, per the architecture's graph decision), with the Blueprint's PROCESS rules governing the required shape (one issue per PR; features, tests, and criteria as required child collections). The gardening loop's "implementation plan" step populates this graph; the `project` page renders it with live status.

### Suggested sequencing

1. Substrate foundations completes (existing Plan work: #426 → #427 → #428, with #431 for AGE).
2. Daemon/CLI lifecycle (4.2) and seed ingestion (4.3) in parallel.
3. Gardening loop engine (4.4) — first with stubbed agent steps to prove resumability, then real research/reconcile steps.
4. Pages (4.5) and project management graph (4.6) in parallel on top of the loop.
5. End-to-end demo hardening: kill/restart drills, clean-machine install test.

## 5. Acceptance criteria

- [ ] On a machine with no daemon running, any `superfield` command starts the daemon, which starts the Postgres container and reports healthy only after migrations apply.
- [ ] `superfield garden company-background.md prd.md` ingests both documents and starts the gardening loop; the command returns while the loop continues in the background.
- [ ] The gardening loop demonstrably revises pages over time: querying `superfield page prd` before and after a pass shows reconciled content with recorded provenance.
- [ ] `superfield page architecture` and `superfield page plan` return non-empty proposals derived from the seeds within a bounded number of passes.
- [ ] `superfield page project` renders issues where every issue has ≥1 feature, ≥1 required test in its testing plan, and ≥1 acceptance criterion, and every pull-request node links to exactly one issue; transactional status in the rendering reflects graph state at query time.
- [ ] Daemon logs show per-agent gardening activity and are tailable from the CLI.
- [ ] Kill the daemon mid-pass; restart it. The loop resumes from its Postgres cursor with no lost knowledge base or project state (durable volume verified across container restart).
- [ ] The full demo (§2) runs on a clean machine with no GitHub dependency anywhere on the path (standing constraint, technical-requirements).
