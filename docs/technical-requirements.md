# Technical Requirements — What Must Exist for the Vision

> Companion to [`prd.md`](./prd.md). The PRD describes the end state; this document derives, from first principles, the software required to reach it. It is need-driven: every capability below is derived from the product loop and the PRD's constraints, **not** from the current codebase. What has already been built is evaluated against these needs in §3 — kept where it fits, marked disposable where it doesn't. Nothing in this repo is assumed necessary just because it exists.

**Standing constraint: GitHub is never required.** The GitHub-based stack in this repository (issues/PRs/check-runs as control plane, GitHub App auth, k3s deploy commands) is a **prototype** — scaffolding used to prove the orchestration loop while the real substrate was being designed. It is not a component of the appliance and is not on the appliance's dependency path. No appliance may require a GitHub account, a GitHub App installation, or network reachability to github.com. Git interop exists only as optional onboarding import and optional outbound backup.

---

## 1. The end state

A company installs one appliance — the Forge — on infrastructure it controls. It arrives working, seeded with a knowledge base, a project management surface, and a job orchestrator. A department describes an unserved need; agents stand up a working app in days. People use the app; their usage and its errors land in one store alongside the intent and the code. Agents read that signal, infer what the software is actually for, diagnose what is wrong, and propose validated changes; humans set policy and approve. Each app makes the next one cheaper because they share one ground truth. The Forge improves itself the same way. Over years, the company's software is increasingly bespoke — built, maintained, and operated by the appliance — displacing what it would otherwise have bought.

The PRD's constraints bind every design choice below: self-sufficiency (no external toolchain in the core loop), coherence (one schema, one clock, one trust model), end-to-end verifiability, a hard validation gate, workspace isolation, unified authentication, auditability, enterprise reliability, and green-wedge adoption.

---

## 2. The required software, derived

Walk the loop — a request becomes an app, usage becomes signal, signal becomes change, change becomes deployment, everything is governed and remembered — and twelve pieces of software fall out. For each: what it must do, the hard requirements the vision imposes, and the open design questions. Capability names are used here, not component names; what exists today is mapped in §3.

### 2.1 The brain — one store for every kind of fact

The foundation of everything. One store holding operational facts (events, errors, sessions — event-sourced, so "what was true at time T?" needs no separate audit system), semantic knowledge (embeddings co-located with the rows they annotate), structured intent (requirements and issues as records with foreign keys into what they govern, not text in a tracker), and causal links (the traversable chain requirement → feature → code → error → affected users).

Hard requirements: one schema, one clock, one trust model; agents as first-class writers; per-workspace isolation enforced in the data layer, not in application code; enterprise-grade backup, recovery, and availability — one store concentrates risk, so recoverability is launch-critical; access control that travels with the data.

The schema is the product. Designing it — how intent, behavior, code, and causality are represented so agents can reason over them — is the single largest piece of design work in the roadmap, and it is top-down work: it cannot be assembled by unioning the schemas of components that happen to exist.

Open: adopt vs. build the engine (the vision doc is explicit — use a commercial store if one can hold all four fact kinds under one schema and clock; build only if none can); how event-sourcing and the single clock are realized; data-residency boundaries for multinational workspaces.

### 2.2 Change management at agent cadence

Agents produce changes orders of magnitude faster than humans, with no human watching each merge. The need is not "a VCS" — it is four guarantees:

- **Durable, versioned code state** living in the brain, joined to the intent and errors that motivated each change.
- **Safe reconciliation** of concurrent changes from many agents and humans — semantically aware, with a verification gate such that nothing that fails to compile or violates constraints ever lands. Silent mis-merges are fatal in a lights-out system.
- **Provenance** — every change carries its full reasoning chain: prompt, retrieved context, tool trace, validation outcome. This is what makes review-by-human and audit-by-regulator possible.
- **Isolated forks** of live state, cheap enough to create per-proposal.

Git compatibility matters only at the boundary: importing existing code during onboarding, optionally exporting for backup. The internal change model owes nothing to Git's design, which encodes human-paced asynchronous collaboration.

Open: how much version-control surface area the appliance actually needs internally (likely far less than a general VCS); language coverage strategy for semantic safety.

### 2.3 The execution fabric

Everything the appliance does runs somewhere: the Forge itself, every validation job, every delivered app. The fabric must provide:

- **Strong isolation** — a real trust boundary per project (the enterprise is trusting this thing on its infrastructure), with cheap per-agent fan-out inside it.
- **Sub-second fresh environments** — validation must be the agent's _inner loop_, not a queue. This is an economics requirement, not a convenience: if each validation attempt costs minutes, agents iterate at human speed and the cost-per-app never collapses. The latency target is the requirement; the mechanism (microVM forking, snapshot/restore, warm pools) is an implementation choice to be validated.
- **Artifact build and storage** — turning merged change into runnable form, stored inside the appliance. No external registry.
- **Deployment and observation** — placing app instances on whatever hosts the enterprise points the Forge at (starting with the Forge's own host), watching their health, rolling forward and back. No general-purpose orchestration platform as a dependency.

### 2.4 The loop engine

The orchestrator that drives plan → develop → validate → review → merge → deploy → observe, continuously, for every app including the Forge. Requirements derived from the vision: processes are stateless and resumable from the brain alone (the appliance must survive crashes and restarts with zero lost work); a broken live system always outranks new feature work; many agents work concurrently with sequenced, gated merging; in-flight agent sessions are durable and resumable; the loop runs identically whether the workspace is a customer app or the Forge itself — self-improvement is not a special case.

### 2.5 Agent capability

The intelligence doing the work. Three parts:

- **An agent runtime** — spawning, steering mid-task, escalating, and accounting for LLM agents, with per-agent cost metering and budget enforcement (an Owner must be able to see and cap what autonomy costs).
- **Encoded engineering judgment** — the opinionated knowledge of how to build software correctly (architecture, security, testing, antipatterns), applied as a _binding_ input to validation, not advice. Encoding evolves: explicit rules first, model weights when the loop can fund and evaluate fine-tuning. The training pipeline — episodes → curriculum → fine-tune → evaluation — is itself software to build.
- **Learning from history** — agents' own past runs, recorded as episodes in the brain, audited to tighten the curriculum so the autonomy success rate rises over time instead of holding constant.

LLM capability itself is the one external dependency the loop cannot internalize today. It must be a governed boundary: vendor-abstracted, metered, and swappable — including for enterprises that will demand models inside their own trust perimeter.

### 2.6 The gates — validation and policy

Two distinct gates, both non-negotiable per the PRD:

- **Validation** — no change merges without passing against a _current_ baseline in an isolated environment, where "passing" includes conformance to the governed architectural and security constraints the brain holds, not test results alone. The open question of how a trustworthy baseline is established for code with thin test coverage must be answered here.
- **Policy** — the Owner's autonomy vocabulary: which risk levels ship without a human, which require approval, per workspace. Policy is a small set of versioned, auditable objects with a lifecycle — not a configuration surface. Enforcement points live at merge and at deploy. The design tension (expressive enough to be real, small enough to not become settings) is a PRD open question that gets answered in this component.

### 2.7 Signal capture

The "observe" edge, without which there is no learning — only code generation. Every delivered app must emit usage signal _by construction_: sessions and user actions as structured events; runtime errors as structured records with keys into the feature graph (never log strings); all stamped on the brain's clock. This implies a telemetry layer baked into the app platform (§2.9), plus ingestion paths from running instances into the brain, plus metering of the agents themselves (their cost and outcomes are signal too).

### 2.8 The inference engines

The software that converts signal into direction — the vision's distinctive claims, with no off-the-shelf analog:

- **Spec inference** — read the behavioral trace, infer what the software is actually used for, diff against stated goals, surface the delta as a proposed specification for a human to confirm or correct. The spec is continuously revised, never authored.
- **Diagnosis** — on a production error, traverse the causal chain (error → session → affected users → requirement → current code) and produce a grounded diagnosis and proposed change within minutes, so the human reviews a fix instead of assembling an investigation.
- **Gap surfacing** — the brain's synthesized, continuously current view of the business, used to spot operational gaps that become the next proposed apps. This is the expansion engine of the green wedge: it is how one app becomes ten without a sales motion.

All three are agent applications over the brain's causal graph. They are only as good as the schema (§2.1) and the signal (§2.7) beneath them — which is why those come first.

### 2.9 The app platform

What a delivered app is _made of_. When agents stand up an app in days and maintain it unattended, the apps must be radically uniform: one opinionated scaffold — stack, runtime shape, auth integration, telemetry, fixtures — that agents instantiate and the fabric (§2.3) runs. Uniformity is a feature: every app an agent has seen is shaped like every app it will touch.

The scaffold bakes in: the shared authentication layer (§2.10), the telemetry SDK (§2.7), a data layer that reads the brain and — through governed, read-only connectors — the enterprise's existing systems of record, without modifying them. The connector boundary (what is read live vs. copied into the brain, and who governs that) is a PRD open question answered here.

### 2.10 The surfaces

Two per app, behind one sign-on:

- **The delivered app** — generated from the platform above, used by the requesting team.
- **The control panel** — where humans steer: stating intent; watching agents work against a live preview and correcting them mid-task; reviewing a gated change _with its full reasoning chain in one place_ (intent, error, affected users, validation — approve or reject without assembling context); monitoring every active agent's task, elapsed time, and cost; reviewing components and screens against representative data across device sizes; overseeing deployment health and rolling back.

And the identity beneath both: enterprise SSO mapped to the PRD role model (Owner, Requestor, Steerer, Collaborator, Agent, Auditor, Viewer), with agents as first-class principals so policy and audit apply to them uniformly, and with a person's permissions identical on both surfaces.

### 2.11 Audit, governance, and notification

Autonomy is purchased with accountability. An append-only record of every agent action and decision _with its reasoning_, queryable by an Auditor — why any rule, change, or decision exists and what it affected. The policy objects of §2.6 versioned and reviewable. And the one outbound integration the loop requires: notifying a human when a change awaits approval or a high-severity signal fires.

### 2.12 The appliance shell

What makes all of the above a product a company installs rather than a stack a team operates:

- **Single-artifact installation** — the Forge comes up as one self-contained unit: brain, change management, validation runner, deployment controller, seed apps, all together, on the customer's infrastructure.
- **Seed apps as real workspaces** — the knowledge base, project management surface, and job orchestrator arrive as ordinary Superfield apps in the brain, so the Forge's own loop improves them from day one. This is the mechanism that makes "the Forge is itself a Superfield app" literally true.
- **Self-upgrade** — the Forge ships changes to itself through its own validate-review-deploy loop. There is no vendor release process to operate.
- **Self-operation** — the appliance has no ops team. Its own backup, recovery, replication, and health monitoring are product features, meeting hard recovery objectives.

---

## 3. What exists, evaluated against the needs

Honest mapping of current assets to §2 — what carries forward, what is disposable, and where fit is unproven. Nothing here is grandfathered in.

**The prototype orchestrator** (this repo's CLI: GitHub control plane, planning/dev/doc loops, control webapp, k3s/cloud ops commands). _Need addressed:_ §2.4 loop engine and §2.10 control panel — as a proof. What it proved is real and carries forward: the planning model (scout-gated phases, sequential merge invariant, broken-main-first), prompts-as-code, multi-slot concurrent agents, durable resumable sessions, mid-task steering, the doc-consistency loop. What is disposable: GitHub as the control plane, GitHub App auth, GitHub Actions as validation, k3s and the cloud-provider deploy path, the Bun server constellation. The patterns survive; the substrate does not. The prototype was the right way to learn the loop and is not the appliance's first version.

**Sharp** (database-native semantically-aware VCS; v1 working — TS/Rust semantic merge with compile gate, episodes, git import/export). _Need addressed:_ §2.2, and it embodies the right guarantees: no silent mis-merge, no non-compiling merge, provenance via episodes, state in the brain's store. Carried forward on its merits. Not forced: the full VCS surface. The appliance's internal change model may need much less than a general-purpose VCS, and git interop is an onboarding-boundary feature, not a core one. The requirement is the four guarantees of §2.2; Sharp is retained exactly as far as it is the cheapest way to deliver them.

**Nexum** (block-level document intelligence: ingestion, addressable blocks, typed link graph, local embeddings). _Need addressed:_ part of §2.1 — the knowledge dimension. Fit caution: Nexum as built is a document system; the brain is much more — structured intent, event-sourced operational facts, causal links into code and behavior. The risk to avoid is treating document ingestion as the brain and bolting the rest on. The brain schema must be designed top-down as §2.1 demands; Nexum's block/link/embedding primitives are strong inputs to that design, not its frame.

**The Blueprint** (compiled rule graph: 1,231 nodes of architecture, security, testing, antipattern knowledge; today advisory). _Need addressed:_ §2.5 encoded judgment. The knowledge is the asset and carries forward. The gap is integration depth — it must become a binding validation input, and eventually training data for the fine-tuned model. Its current advisory wiring is prototype-era and disposable.

**fastenv** (designed: Firecracker microVM per project, crun containers per agent, copy-on-write fan-out). _Need addressed:_ §2.3. The design matches the isolation and fan-out requirements well. The load-bearing bet is sub-second environment forking; that is an unvalidated latency target, and if microVM forking cannot meet it, the requirement stands and the mechanism changes (snapshot pools, warm fleets). Build it as the answer to §2.3's requirements, not as a project with its own momentum.

**The substrate decisions** (one Postgres instance, schema-per-component, governed 384-dim local embeddings, recursive-CTE graph traversal, RPO/RTO targets with backup/replication seams). _Need addressed:_ the engine layer of §2.1, and they answer the adopt-vs-build question correctly for now (stock Postgres + extensions, nothing exotic). Carried forward. What they do not yet provide: event-sourcing, the single clock, intent-as-records, the causal-link population across code and behavior — the brain _schema_ itself, which remains the largest unstarted design artifact in the roadmap.

**Not yet existing in any form:** the spec-inference, diagnosis, and gap-surfacing engines (§2.8); the telemetry SDK and signal ingestion (§2.7); the app platform scaffold (§2.9); policy objects and enforcement (§2.6); the unified review surface, enterprise SSO and agents-as-principals (§2.10); the audit surface and notifications (§2.11); the appliance shell — installer, seed apps, self-upgrade, self-operation (§2.12); the systems-of-record connectors (§2.9); the Blueprint training pipeline (§2.5). These are the majority of the vision's distinctive software, and none of it has a prototype-era stand-in.

---

## 4. Build order

Dependency order, not phases. Each step is gated by what it must write into or run on.

The prototype orchestrator (GitHub control plane, blueprint-governed process) and the final appliance substrate are distinct. Service delivery—planning, development, validation, review, deployment—runs continuously on the blueprint process throughout the build order. Customer-facing apps, production usage, and their signal exist from day one, growing the feedback artifacts (plans, issues, episodes) that shape the brain schema (§2.1) and the appliance's design. Each build step re-roots the substrate beneath the running process; the process itself does not pause. This dissolves the "most expensive guess in the plan" critique: the loop learns continuously while the substrate is built underneath.

1. **The brain schema, isolation, and reliability** (§2.1) — designed top-down, with workspace isolation and recovery built in from the first migration. Everything else writes into this; getting it wrong is epistemic debt that compounds.
2. **Change management and the execution fabric** (§2.2, §2.3) — the loop's hands. Independent of each other; both depend only on the brain.
3. **The loop engine, re-rooted** (§2.4, §2.6) — the proven orchestration patterns rebuilt on brain-native primitives: intent records instead of issues, internal change management instead of a forge, fabric-run validation instead of external CI, with the validation and policy gates enforced. This is the moment the standing constraint is met structurally: the core loop completes with no external service.
4. **The app platform and signal capture** (§2.7, §2.9) — apps that can be stood up uniformly and that sense by construction. This is also the moment the first real wedge app can be delivered to a requesting team.
5. **The inference engines** (§2.8) — spec inference, diagnosis, gap surfacing. The appliance starts learning. Only buildable now: they read the schema of step 1 through the signal of step 4.
6. **The appliance shell** (§2.10–§2.12 completing) — single-artifact install, seed apps as workspaces, SSO, audit surface, self-upgrade through its own loop. The first install where the Forge ships a validated change to itself closes the thesis.

The test for "done" at the end: an enterprise installs one artifact on its own infrastructure; a department gets a working app in days; the loop from a production error to a reviewed, deployable fix runs in minutes; no step requires GitHub, an external CI service, a registry, or an orchestration platform; every agent decision is auditable; and the appliance that did all this is running software it improved itself.
