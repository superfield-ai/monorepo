# Architecture

> Canonical technology and vendor reference for Superfield. Product scope and requirements live in [`prd.md`](./prd.md); the product thesis lives in [`vision/unified-memory-layer.md`](./vision/unified-memory-layer.md). This document covers *how* the system is built — the technologies, vendors, and architectural constraints — not *what* it does.

## 1. Overview

Superfield builds and continuously improves net-new enterprise applications inside a single **company brain**: one coherent store holding each app's source code, changes, validation results, issues, specifications, documents, and runtime behavior together, with agents as first-class writers (PRD §1). The architectural posture follows directly from the unified-memory thesis: collapse the development stack's fragmented systems — version control, the forge, CI, the issue tracker, the warehouse — into primitives native to one store, so the core loop (intent → change → validation → review → deploy) completes without crossing a system boundary or depending on any external forge or CI service (PRD §9; vision "No Assumed Priors"). Three Superfield-owned components realize this: **Nexum** (the unified store), **Sharp** (agent-native version control), and **FastEnv** (on-demand isolated validation environments).

## 2. Technology Stack

| Layer | Choice | Rationale | Source |
|-------|--------|-----------|--------|
| Database (primary / unified store) | **Nexum** — company knowledge graph | One coherent store for operational facts, semantic knowledge (embeddings co-located with the rows they annotate), structured intent, and the causal links among them, under one schema, one clock, one trust model | PRD §1, §9; vision "What the Store Must Do" |
| Version control / delivery plane | **Sharp** — agent-native VCS | A change is an isolated fork of the live state, validated, then merged; pull requests are gated deltas — the branch/PR without external-forge protocol overhead | PRD §5, §9; vision "No Assumed Priors" |
| Validation compute / environment forking | **FastEnv** — ultrafast environment forking | Isolated environments forked from the live state on demand, locally or on federated machines when capacity is needed; provisioned → active → torn down | PRD §5, §6, §7 |
| CI / validation | **FastEnv** — replaces external CI infrastructure (e.g. GitHub Actions / hosted runners). Validation runs as jobs spawned on demand into forked environments against the current baseline in the store, not a standing server fleet or webhook-driven runner pool | Self-sufficient core loop; no hard dependency on an external CI service | PRD §8, §9; vision "No Assumed Priors" |
| Observability | Runtime behavior, errors, and sessions written back into Nexum as event rows with foreign keys into the feature/requirement graph — not a separate APM | Closes the signal-to-correction loop inside the brain; no boundary crossing | PRD §5; vision "Self-Improving Software" |
| Auth / identity / security | Superfield-owned security stack (session, authorization, policy); federates to the enterprise's existing SSO/IdP (OIDC/SAML) as an authentication source where present | Unified auth across both surfaces, mapped to the role model; security is owned end-to-end, not outsourced — part of the moat | PRD §7, §9 |
| Agent execution | Provider-neutral LLM abstraction; end users select their inference provider(s) per workspace (bring-your-own) | Agents are the actors that propose, validate, and ship changes; enterprises bring their own provider for residency and existing-contract reasons | PRD §3, §7 |
| Systems-of-record integration | Read-only connectors to the enterprise's existing systems | Green-wedge: an app uses data the business maintains without modifying or replacing those systems | PRD §7, §9 |
| Notifications | A notification transport that alerts a human on pending approval or high-severity signal | Policy-required approvals and signals must reach a human | PRD §7 *(vendor `[unanchored]`)* |
| Infrastructure / hosting / deploy targets | The enterprise's chosen hosting environments; each workspace isolated from every other | Ship the application to the customer's targets; workspace isolation is launch-critical | PRD §7, §9 *(vendor/topology `[unanchored]`)* |
| Runtime / language | TypeScript (Bun) monorepo (`packages/*`) | Existing codebase convention; single typed toolchain for clients, prompts, and skills | codebase convention *(no product-doc anchor)* |

Layers intentionally omitted — not applicable or not anchored in any source: dedicated web framework, secondary/cache database, async queue, object storage, email, payment processing. Add them only when a requirement motivates them.

## 3. Vendor Selections

| Vendor / component | Category | Source |
|--------------------|----------|--------|
| **Nexum** (`superfield-ai/nexum`) | Unified operational store — the company brain | PRD §1, §9; vision "Superfield" |
| **Sharp** (`superfield-ai/sharp`) | Agent-native version control / delivery plane | PRD §5, §9; vision "Superfield" |
| **FastEnv** (`superfield-ai/fastenv`) | Ultrafast isolated environment forking + validation compute; CI infrastructure (replaces GitHub Actions / hosted runners) | PRD §5, §7, §8 |
| Enterprise IdP (federated) | External authentication source only (OIDC/SAML); Superfield owns session, authorization, and policy | PRD §7, §9 |
| LLM inference provider(s) | Agent execution — provider-neutral, end-user-selectable (bring-your-own) | PRD §7 |
| Notification transport | Human alerting | PRD §7 — `[unanchored]` |
| Hosting / deploy target | Application hosting | PRD §7 — `[unanchored]` (per-customer choice) |

## 4. Architectural Constraints

- **Self-sufficiency.** The core loop — intent, change, validation, review, deploy — must complete without a hard dependency on any external forge or CI service. Sharp and FastEnv exist to satisfy this; external forges/CI may be imported from but are not in the critical path. (PRD §9; vision "No Assumed Priors")
- **Coherence.** Operational facts and knowledge share one schema, one clock, and one trust model — any fact joins to any related fact without translation. This is a constraint on Nexum's design, not an optional optimization. (PRD §9; vision "What 'Unified' Means")
- **Source and project state live in the store.** Source code, issues, specs, reviews, and project state are rows/objects in Nexum reached via Sharp, not files in an external Git tree synced to a remote. (vision "No Assumed Priors")
- **End-to-end verifiability.** Every change must be traceable from the intent that motivated it, through the validation that gated it, to the runtime behavior it produced. (PRD §9)
- **Validation gate.** No change may merge without passing validation against a current baseline; no change above the policy-defined risk threshold may ship without human approval. (PRD §9; PRD §5)
- **Isolation and access control.** Each enterprise workspace is isolated from every other, and access control travels with the data rather than living in a separate system. Because one store concentrates risk, isolation and recoverability are launch-critical. (PRD §9; vision "The Moat Is in the Hard Parts")
- **Unified authentication.** Both surfaces — the delivered app and the control panel — sit behind one shared, enterprise-grade auth layer mapped to the role model; neither may carry a weaker access model than the other. (PRD §9)
- **Auditability and governance.** Every agent action, decision, and the reasoning behind it must be recorded and reviewable. (PRD §9)
- **Reliability.** The brain must meet enterprise expectations for availability, backup, and recovery. (PRD §9)
- **Green-wedge adoption.** Enter on a net-new app requiring no change to systems of record and no migration; reads from systems of record are read-only. (PRD §9)
- **No general-purpose analytics surface.** Nexum synthesizes a current view in service of deciding and steering software work; it is not a data warehouse or BI/observability platform for reporting unrelated to the development loop. (PRD §8)

## 5. Decisions

Resolved in an expert decision session (2026-05-30):

- **Nexum: build the engine.** Build Nexum from lean primitives around the coherence guarantee, not as a thin layer over a commercial database — the moat is the hard parts (coherence, isolation, a trustworthy baseline), and defensible infrastructure is prioritized over speed-to-first-customer. *(D0, D1)*
- **Authorization in the store.** Access control lives in Nexum as policy / row-level security that travels with the data, not in a separate authz system. *(D7)*
- **Systems-of-record boundary — phased.** SoR data is a read-through, second-class projection under the green wedge (read-only; never modify or replace). The architecture must let that data **graduate to first-class/authoritative** as Superfield becomes the system of record (vision "Where This Goes"). The coherence guarantee is absolute for Superfield-authored facts; external SoR data is a projection Superfield eventually supplants. *(D2)*
- **FastEnv compute in the customer's environment.** Validation/CI runs inside the customer VPC, not Superfield-managed central infrastructure — data residency, and eventually hosting authoritative data, demand it. *(D5)*
- **Agent execution: provider-neutral, bring-your-own.** A provider-neutral LLM abstraction; end users select their inference provider(s) per workspace rather than coupling to one frontier model. *(D3)*

- **Security stack: owned, with federated authentication.** Superfield owns the entire security stack — session, authorization (in Nexum), and policy. It federates to the enterprise's existing SSO/IdP (OIDC/SAML) as an authentication source where present, but does not outsource the security model to a bought auth vendor; security is part of the moat. *(D4)*
- **Notifications: control-panel-only.** Approvals and high-severity signals surface in the control panel; an external notification transport (email/Slack/webhook) is deferred until a requirement forces it. *(D6)*

## 6. Source Coverage

| Source doc | Rules / facts applied | Not applicable |
|------------|------------------------|----------------|
| `prd.md` | §1 company brain & two surfaces; §3 roles (Agent, IAM); §5 workflows (isolated fork, on-demand validation, deploy-and-learn); §6 entity lifecycle (isolated environment, validation run); §7 integration needs; §8 out-of-scope boundaries; §9 constraints | User stories phrased as product behavior, success metrics, open product questions (product scope, not stack) |
| `vision/unified-memory-layer.md` | "What the Store Must Do", "No Assumed Priors", "What 'Unified' Means", "The Moat Is in the Hard Parts", "Self-Improving Software", "Superfield" | Market positioning, GTM, "Where This Goes" trajectory (vision/pitch, not stack) |
| `architecture*` / `*plan*` / `technical*` | — | None present (removed to rebuild); this document is the new canonical technology reference |
