# Architecture

> Canonical technology and vendor reference for Superfield. Product scope and requirements live in [`prd.md`](./prd.md); the product thesis lives in [`vision/unified-memory-layer.md`](./vision/unified-memory-layer.md). This document covers *how* the system is built — the technologies, components, and architectural constraints — not *what* it does. The named components (Sharp, Nexum, FastEnv, Blueprint) are Superfield-owned projects; this doc reflects their actual implementations, not aspirations.

## 1. Overview

Superfield builds and continuously improves net-new enterprise applications, steered by the requesting team with agents as first-class actors (PRD §1). The architectural posture follows the unified-memory thesis: collapse the development stack's fragmented systems — version control, the forge, CI, the tracker — into Superfield-owned, PostgreSQL-backed components, so the core loop (intent → change → validation → review → deploy) completes without depending on an external forge or CI service (PRD §9; vision "No Assumed Priors"). Four owned components realize this:

- **Sharp** — a database-native, semantically-aware VCS. Repository state, Tree-sitter ASTs / symbol tables, and agent **episodes** live in PostgreSQL; it has a three-tier semantic-merge contract and is Git-compatible (exportable to GitHub for backup/sharing).
- **Nexum** — block-level document/knowledge intelligence on PostgreSQL + `pgvector`. Ingests documents into addressable blocks and builds a typed cross-link graph; serves full-text, semantic, and graph queries from one database. Holds specs, requirements, and documents — **not** source code.
- **FastEnv** — a project-isolated workspace runtime: one Firecracker microVM per project, with `crun` containers per agent task inside it. Validation/CI runs inside this boundary.
- **Blueprint** (`brain/`, `superfield-blueprint`) — the architectural and security rules agents build against.

These components are developed in their own repositories but are adapted to **embed into a single Superfield binary over one shared PostgreSQL instance** — not run as separate services each with its own database. Realizing this coherently — avoiding duplicated infrastructure and multiple Postgres instances — requires non-trivial edits to the subprojects and is the central integration work (see §5).

## 2. Technology Stack

| Layer | Choice | Rationale | Source |
|-------|--------|-----------|--------|
| Database engine (substrate) | **PostgreSQL** (+ `pgvector` HNSW, recursive CTEs) | One engine serves relational, full-text, semantic (vector), and graph-traversal queries; Sharp and Nexum both build on it, deliberately avoiding separate graph/vector databases | nexum `docs/engineering.md`; sharp README |
| Code / VCS store | **Sharp** — database-native semantic VCS (Postgres) | Repo state, Tree-sitter ASTs + symbol tables, and agent **episodes** (prompts, context, tool traces, patches, validation outcomes, judge results) live in the DB; three-tier semantic-merge contract; Git-compatible export | sharp README / whitepaper; PRD §5, §9 |
| Knowledge / document store | **Nexum** — block-level document intelligence (Postgres + pgvector) | Documents → addressable blocks → typed cross-link graph; full-text + semantic + graph in one query; holds specs, requirements, documents (not code) | nexum README / `docs/engineering.md`; PRD §1 |
| Validation / CI execution + isolation | **FastEnv** — Firecracker microVM per project, `crun` container per agent task | Strong per-project trust boundary with cheap per-agent fan-out; validation/CI runs inside it, replacing external CI infrastructure (e.g. GitHub Actions / hosted runners); host-side eBPF monitoring | fastenv README / `docs/prd.md`; PRD §5, §7, §8 |
| Architectural / security rules | **Blueprint** (`brain/`) | The architectural constraints, security patterns, and antipatterns agents build against | superfield-blueprint |
| Observability | Agent runs captured as Sharp **episodes** (incl. validation outcomes); runtime behavior/errors flow back into the store as signal — not a separate APM | Closes the signal-to-correction loop inside the owned stores; no boundary crossing | sharp README; PRD §5; vision "Self-Improving Software" |
| Auth / identity / security | Superfield-owned security stack (session, authorization, policy); federates to the enterprise's existing SSO/IdP (OIDC/SAML) as an authentication source where present | Unified auth across both surfaces, mapped to the role model; security owned end-to-end, not outsourced — part of the moat | PRD §7, §9 |
| Agent execution | Provider-neutral LLM abstraction; end users select their inference provider(s) per workspace (bring-your-own) | Agents propose, validate, and ship changes; enterprises bring their own provider for residency / existing-contract reasons | PRD §3, §7 |
| Systems-of-record integration | Read-only connectors to the enterprise's existing systems | Green-wedge: use data the business maintains without modifying or replacing those systems | PRD §7, §9 |
| Notifications | A transport that alerts a human on pending approval or high-severity signal | Policy-required approvals and signals must reach a human | PRD §7 *(vendor `[unanchored]`)* |
| Infrastructure / hosting / deploy targets | The enterprise's chosen hosting environments; each workspace isolated | Ship the app to the customer's targets; workspace isolation is launch-critical | PRD §7, §9 *(vendor/topology `[unanchored]`)* |
| Runtime / language | TypeScript (Bun/Node) for services and clients; Rust for performance-critical paths (Nexum ingestion; Sharp's TS+Rust semantic-merge support) | Existing project conventions across the Superfield repos | sharp README; nexum README; cli codebase |

Layers intentionally omitted — not applicable or not anchored: dedicated web framework, separate cache, async queue, object storage, email, payment. Add them only when a requirement motivates them.

## 3. Components & Vendor Selections

| Component / vendor | Category | Source |
|--------------------|----------|--------|
| **PostgreSQL** (+ pgvector) | Database substrate for Sharp and Nexum | nexum `docs/engineering.md`; sharp README |
| **Sharp** (`superfield-ai/sharp`) | Database-native semantic VCS — repo state, ASTs, episodes, three-tier merge, Git export | sharp README; PRD §5, §9 |
| **Nexum** (`superfield-ai/nexum`) | Block-level document/knowledge intelligence — corpus blocks + typed cross-link graph | nexum README; PRD §1 |
| **FastEnv** (`superfield-ai/fastenv`) | Project-isolated workspace runtime (Firecracker + crun); validation/CI execution; replaces external CI | fastenv README; PRD §5, §7, §8 |
| **Blueprint** (`brain/`, `superfield-blueprint`) | Architectural / security rule set agents build against | superfield-blueprint |
| Enterprise IdP (federated) | External authentication source only (OIDC/SAML); Superfield owns session, authz, policy | PRD §7, §9 |
| LLM inference provider(s) | Agent execution — provider-neutral, end-user-selectable (bring-your-own) | PRD §7 |
| Notification transport | Human alerting | PRD §7 — `[unanchored]` |
| Hosting / deploy target | Application hosting | PRD §7 — `[unanchored]` (per-customer choice) |

## 4. Architectural Constraints

- **Self-sufficiency.** The core loop — intent, change, validation, review, deploy — must complete without a hard dependency on any external forge or CI service. Sharp and FastEnv satisfy this; external forges/CI may be imported from/exported to but are not in the critical path. (PRD §9; vision "No Assumed Priors")
- **Coherence.** Operational facts and knowledge share one schema, one clock, and one trust model — any fact joins to any related fact without translation. This is a constraint on the store layer (Sharp + Nexum on PostgreSQL), not an optional optimization. (PRD §9; vision "What 'Unified' Means")
- **State lives in the owned stores.** Source code, change history, and agent episodes live in Sharp's database; specs and documents live in Nexum — not in an external Git tree synced to a remote. Git remains a compatible export target, not the source of truth. (sharp README; vision "No Assumed Priors")
- **End-to-end verifiability.** Every change must be traceable from the intent that motivated it, through the validation that gated it, to the runtime behavior it produced — captured in Sharp episodes. (PRD §9; sharp README)
- **Validation gate.** No change may merge without passing validation against a current baseline; no change above the policy-defined risk threshold may ship without human approval. Sharp's merge contract is designed to never silently pick between two semantically valid resolutions and never emit a non-compiling merge. (PRD §9, §5; sharp README)
- **Isolation and access control.** Each enterprise workspace is isolated from every other (FastEnv enforces a per-project microVM boundary), and access control travels with the data (PostgreSQL RLS/policy) rather than living in a separate system. (PRD §9; fastenv README; vision "The Moat Is in the Hard Parts")
- **Unified authentication.** Both surfaces — the delivered app and the control panel — sit behind one shared, enterprise-grade auth layer mapped to the role model; neither may carry a weaker access model than the other. (PRD §9)
- **Auditability and governance.** Every agent action, decision, and the reasoning behind it must be recorded and reviewable. (PRD §9)
- **Reliability.** The stores must meet enterprise expectations for availability, backup, and recovery. (PRD §9)
- **Green-wedge adoption.** Enter on a net-new app requiring no change to systems of record and no migration; reads from systems of record are read-only. (PRD §9)
- **Single shared substrate.** The owned components embed into one Superfield binary backed by a single PostgreSQL instance; components do not run separate databases or duplicate infrastructure. Coherence is realized by literal co-location in one store, not by integrating across multiple stores. (Direction 2026-05-30; PRD §9)
- **No general-purpose analytics surface.** The store synthesizes a current view in service of deciding and steering software work; it is not a data warehouse or BI/observability platform for reporting unrelated to the development loop. (PRD §8)

## 5. Decisions

Resolved in expert decision sessions (2026-05-30):

- **Build defensible infrastructure over speed-to-first-customer.** The owned components are the moat. *(D0)*
- **Own the stack as products, on PostgreSQL.** Sharp (semantic VCS + episodes), Nexum (document/knowledge graph), FastEnv (isolation runtime), and the security stack are built **on PostgreSQL + pgvector**, not a from-scratch storage engine. The moat is the owned semantics and guarantees — Sharp's semantic merge and episode model, Nexum's block/link graph, coherence, isolation, owned security — not a novel engine. *(D1 — corrected: an earlier draft mis-stated this as "build from primitives, not a commercial DB"; the actual code is Postgres-based by design, which Nexum's engineering doc adopts explicitly to avoid separate graph/vector databases.)*
- **Authorization in the store.** Access control lives in the database as policy / row-level security that travels with the data, not in a separate authz system. *(D7)*
- **Systems-of-record boundary — phased.** SoR data is a read-through, second-class projection under the green wedge (read-only; never modify or replace), architected to **graduate to first-class/authoritative** as Superfield becomes the system of record (vision "Where This Goes"). Coherence is absolute for Superfield-authored facts; external SoR data is a projection Superfield eventually supplants. *(D2)*
- **FastEnv compute in the customer's environment.** Validation/CI runs inside the customer VPC, not Superfield-managed central infrastructure — data residency, and eventually hosting authoritative data, demand it. *(D5)*
- **Agent execution: provider-neutral, bring-your-own.** A provider-neutral LLM abstraction; end users select their inference provider(s) per workspace rather than coupling to one frontier model. *(D3)*
- **Security stack: owned, with federated authentication.** Superfield owns the entire security stack — session, authorization, policy. It federates to the enterprise's existing SSO/IdP (OIDC/SAML) as an authentication source where present, but does not outsource the security model to a bought auth vendor. *(D4)*
- **Notifications: control-panel-only.** Approvals and high-severity signals surface in the control panel; an external notification transport (email/Slack/webhook) is deferred until a requirement forces it. *(D6)*

- **Store composition: single shared PostgreSQL, single binary.** Sharp, Nexum, and the rest share **one PostgreSQL instance** and embed into **one Superfield binary**, rather than running as separate services each with its own database. This makes the "one coherent store" literal and avoids duplicated infrastructure. *(Direction set 2026-05-30.)*

Integration work (consequence of the above):

- The subprojects stay in their own repositories but need non-trivial edits to import coherently into the main binary and target a shared Postgres instance rather than provisioning their own. **Open:** the exact schema-sharing boundary (one schema vs. namespaced schemas within one instance) and how each repo's migrations and lifecycle are reconciled under a single binary.

## 6. Source Coverage

| Source | Facts applied | Not applicable |
|--------|---------------|----------------|
| `prd.md` | §1 brain & two surfaces; §3 roles; §5 workflows; §6 entity lifecycle; §7 integration needs; §8 boundaries; §9 constraints | User stories as product behavior, success metrics, open product questions |
| `vision/unified-memory-layer.md` | "What the Store Must Do", "No Assumed Priors", "What 'Unified' Means", "The Moat Is in the Hard Parts", "Self-Improving Software", "Where This Goes" | Market positioning / GTM (pitch, not stack) |
| `~/superfield/sharp` (README, whitepaper) | Sharp role, Postgres backing, episodes, semantic-merge contract, Git interop | v1 12-week build sequence (delivery, not stack) |
| `~/superfield/nexum` (README, `docs/engineering.md`) | Nexum role, Postgres+pgvector substrate, block/link data model | Legal-corpus-specific scale targets |
| `~/superfield/fastenv` (README, `docs/prd.md`) | Firecracker-per-project + crun-per-agent isolation model; CI execution | Host eBPF/jailer specifics |
| `~/superfield/brain` | Blueprint = `superfield-blueprint` rule set | Individual rule content |
