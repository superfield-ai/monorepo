# Product Requirements Document

> Canonical product requirements for Superfield — the product-facing source of truth. Implementation and vendor choices are out of scope here by design — see `architecture.md`. The product thesis is articulated in [`vision/unified-memory-layer.md`](./vision/unified-memory-layer.md). Terms used across the document corpus are pinned in the [Glossary](#11-glossary).

## 1. Problem Statement

Superfield's customer is a company with more than $10M in annual revenue that does not hire full-time engineers: a skeletal technical staff, possibly led by a technical lead under whatever title the organization gives them — CIO, CTO, or COO. Such a company carries an unserved build backlog: the internal and departmental software it needs but never builds. A team needs a tool to track a process, reconcile two systems, automate a manual workflow, or give a business unit a purpose-built app. Each need is real and funded in principle, but there is no engineering organization to build it, and commissioning custom development for a small internal tool never pencils out. The work falls back to spreadsheets, manual process, brittle no-code patches, or a request that dies in an evaluation folder. There is no off-the-shelf product to buy, because each of these apps is specific to the business. The demand is large, the budget for IT and automation exists, and the backlog only grows.

The backlog persists because the traditional cost of building, _product-managing_, and _maintaining_ a small bespoke application is too high to justify against its individual value. Building it the conventional way scatters its life across disconnected systems — source in one place, issues in another, validation on a server fleet, runtime errors in an observability tool, the spec in a document nobody updates. A human can cross those boundaries; an autonomous agent cannot, because it reads the stale fact with the same confidence as the fresh one. So the distance from a signal to a corrective change stays measured in days or weeks, and a small app is never worth that overhead. The backlog is the visible symptom of a structural cost problem.

A secondary cost is the toolchain itself. Conventional software delivery depends on a constellation of external services — source management, continuous integration, artifact storage, deployment orchestration — each maintained separately, each a boundary an agent must cross. These services were designed for human-paced workflows. Superfield does not outsource its core loop to them.

Superfield attacks the backlog by collapsing both costs. The installation root is the **Forge** — one per company, the single surface through which the company provisions, manages, and operates all Superfield workloads. The Forge manages the company's knowledge base, source code, project management, and deployment: it is the source manager, the CI service, the artifact store, and the deployment controller in one. It is an appliance in the sense of an on-prem NAS or firewall: installed from a signed artifact and administered through a web console by a sysadmin-generalist — the same person who runs the company firewall and the Microsoft 365 tenant — never through a compiler or a config-file edit. Its execution environment is **fastenv**, Superfield's purpose-built execution environment: validation jobs and every app the Forge builds are required to run in fastenv, and moving the Forge itself into fastenv is a scheduled later step (§9) — removing the need for general-purpose container orchestration.

Inside the Forge lives the **company brain** — one coherent store that unifies the knowledge base and the transactional record. Source code, change history, validation results, issues, specifications, documents, and runtime behavior all live together in that store. Agents build and continuously improve apps against it, steered by the requesting team. The same store gives the business a synthesized, continuously current view of itself, and the operational gaps that view surfaces become the next apps the brain builds. Each app is operated first by the people who requested it — whose usage becomes signal — and, over time, by agents themselves. Because each app is net-new, Superfield enters the company as a **green wedge**: it builds software the business does not have and no incumbent system covers, displacing nothing and requiring no rip-and-replace. It lands on one unserved need, proves itself, and expands as more of the backlog moves into the brain — each additional app cheaper and more legible than the last because they share one coherent ground truth.

The Forge is itself a Superfield app. It arrives with three seed capabilities — a knowledge base engine, a project management surface, and a CI job orchestrator — and it self-drives its own construction from that seed. As the company uses it, those seed capabilities become signal: the same loop that improves any other app improves the Forge itself. The Forge does not require a separate upgrade or migration path; it evolves through routine Superfield operation. This makes the Forge the most direct proof of the product's thesis: self-improving software, demonstrated on the system that builds it.

For every app it builds, Superfield delivers two surfaces:

- **The application** the business asked for — the running webapp used by its intended audience.
- **The control panel** (Studio) — the surface through which humans steer the agents building and improving that app: writing intent, reviewing batches of completed candidate states demonstrated against representative data, approving outcomes, monitoring agent activity and cost, designing the experience, and overseeing deployment health. Batch review of completed candidates is the primary mode; watching an agent work against a live preview and steering it mid-task remains available as an interim mode.

Both surfaces sit behind **one shared authentication and access layer**, mapped to the same roles, so that a person's identity and permissions are consistent whether they are using the app or governing the agents that build it.

## 2. Goals and Success Metrics

**Goals**

- Let a company with no full-time engineers ship the net-new internal and departmental apps it would otherwise leave in the backlog, at a cost per app low enough to justify building them.
- Give each app a single, coherent source of truth that humans and agents reason against without crossing system boundaries.
- Close the loop from signal to corrective action so it runs at the speed data updates, not at the speed of human hand-offs — making each app self-maintaining rather than a maintenance liability.
- Let agents perform the development work — proposing, validating, and shipping changes — that humans steer and approve rather than execute. Approval is outcome-level: approvers judge behavior demonstrated against representative data, never code diffs.
- Eliminate the external toolchain: the Forge is the source manager, CI service, artifact store, and deployment controller, so the core loop has no hard dependency on any external service.
- Enter on a single unserved need without rip-and-replace, and expand as more of the backlog moves into the brain.
- Demonstrate the product's thesis on itself: the Forge arrives as a minimal seed and self-improves through the same loop it applies to every other app.

**Success metrics**

Every velocity metric is read together with its paired quality counter-metric; a velocity gain that degrades its counter-metric is a regression, not progress.

- **Time to first app:** time from adoption to a first backlog app shipped and in use is measured in days, not quarters — paired with first-app retention: the app is still in active use a quarter later.
- **Backlog throughput:** the number of previously-unserved apps a company ships per quarter rises, and the per-app cost to build and maintain falls — paired with the defect-reintroduction rate, which must hold steady or fall as throughput rises.
- **Signal-to-correction time:** median time from a signal (a user behavior, an error) to a reviewed, deployable corrective change drops from days to minutes — paired with the rollback rate of shipped corrections, which must not rise as correction latency falls.
- **Self-maintenance:** the share of an app's corrective changes proposed and validated by agents, with humans only approving, rises over time — paired with the approved-vs-proposed ratio, so a loop that generates and then fixes its own defects cannot inflate the share.
- **Expansion:** the number of apps living in the brain per company grows after the initial wedge.
- **Reliability:** the brain meets system-of-record expectations for availability, recoverability, and auditability of every change.

## 3. User Roles

Every role below must be staffable by the target customer — a company with no full-time engineers. No role assumes the ability to read code.

- **Owner / Sponsor** — the company's technical lead, under whatever title the organization gives them (CIO, CTO, COO), accountable for Superfield adoption. Provisions and governs the Forge. Sets policy by selecting and tuning certified policy templates — what counts as a valid correction, what risk level may ship without human review, and what requires sign-off — rather than authoring policy from scratch.
- **Administrator** — the sysadmin-generalist who runs the company's firewall and its productivity/identity tenant. Installs, upgrades, backs up, and recovers the Forge through its console — buttons and forms, never a compiler or a config-file edit. Often the same person as the Owner.
- **Requestor (business unit)** — the department that owns an unserved need, requests an app to address it, and operates that app once it exists so its usage becomes signal.
- **Steerer** — the person accountable for an app's outcome, typically the requesting department's lead or the Owner. Directs agent work by stating intent in business terms and confirming or correcting the agent's inference of intent. Reviews and approves gated changes at the outcome level: behavior demonstrated against representative data, never code diffs. No engineering background is assumed.
- **Collaborator** — proposes and reviews changes within a workspace, and operates the software so its behavior becomes signal.
- **Partner operator (MSP/VAR)** — the managed-service provider or reseller through which Superfield primarily reaches its customers. Operates one or more customer appliances on the customer's behalf — provisioning, monitoring, upgrade, and health — through a multi-appliance fleet-management surface, and may staff the Administrator role for customers who outsource it.
- **Agent** — a first-class, non-human actor that reads the entire brain and writes observations, candidate changes, validation results, and outcomes, acting only within the policy set by the Owner.
- **Auditor / Compliance reviewer** — read-only access to the full history of changes, decisions, and the reasons behind them, for governance and regulatory review.
- **Viewer** — read-only access to project state.

## 4. User Stories

- As an **Owner**, I want to provision a Forge on infrastructure my organization controls so that Superfield runs entirely within our trust boundary from day one and arrives ready to use with its seed capabilities.
- As an **Owner**, I want the Forge to improve its own seed capabilities — the knowledge base, project management, and CI orchestration — through the same agent loop it applies to other apps, so that I never need a separate upgrade process for Superfield itself.
- As an **Owner**, I want the Forge to deploy apps to whatever hosts it can access and observe, so that I can start with a single host for a proof of concept and expand to additional infrastructure as usage grows.
- As an **Owner**, I want to select a certified policy template that governs which changes agents may ship autonomously and which require human approval, so that autonomy stays within the risk tolerance of the business without my having to author policy from scratch.
- As an **Administrator**, I want to install, back up, and recover the Forge through its console the way I administer the company firewall or the Microsoft 365 tenant, so that operating Superfield never requires hiring an engineer.
- As a **Partner operator**, I want to provision, monitor, upgrade, and check the health of every customer appliance I operate from one fleet-management surface, so that I can run Superfield for many customers without per-appliance toil.
- As an **Owner**, I want every agent action and decision recorded with its reasoning, so that I can demonstrate control and accountability to auditors and regulators.
- As a **Steerer**, I want to express what I want the software to do and have an agent infer the rest from how the software is actually used, so that I steer intent instead of authoring detailed specifications.
- As a **Steerer**, I want to review a proposed change as demonstrated behavior — the app exercised against representative data, before and after, together with the intent, the triggering signal, and a plain-language risk statement — so that I can approve or reject an outcome with confidence without ever reading code.
- As a **Steerer**, I want to review a batch of completed candidate states side by side and choose the one that matches intent, so that my attention goes to choosing outcomes rather than supervising agent work turn by turn.
- As a **Steerer**, I want to design and review the app's components and screens against representative data while the agent iterates, so that the experience matches intent before it ships.
- As an **Owner**, I want to monitor every active agent — what it is doing, how long it has run, and what it costs — and intervene or stop it, so that autonomous work stays under control and within budget.
- As an **Owner**, I want to oversee the health of each deployment and roll a change back if it regresses, so that shipping fast never means shipping unsafely.
- As any **user**, I want one sign-on that governs both the app I use and the control panel I steer agents from, so that my identity and permissions are consistent across both.
- As a **Collaborator**, I want to propose a change and have it validated in an isolated environment before it can merge, so that I never destabilize the live system.
- As a **Collaborator**, I want to use the software and have my usage become signal the agents learn from, so that the specification stays current without anyone writing it down.
- As an **Agent**, I want to read the full causal chain from requirement to error to current code in one query, so that the changes I propose address causes rather than symptoms.
- As an **Auditor**, I want to inspect why any rule, change, or decision exists and what it affected, so that I can certify the system's behavior against policy.
- As a **Requestor**, I want to describe a need my department has no software for and get a working app without waiting on the IT roadmap, so that work that used to live in spreadsheets and manual process becomes a maintained application.
- As an **Owner**, I want a new app to read from the systems of record my business runs, without modifying or replacing them, so that adoption requires no rip-and-replace and disturbs nothing in production.

## 5. Core Workflows

**Provisioning the Forge.** An Administrator installs the Forge — a signed artifact — on infrastructure the organization controls; where the company buys through a partner, the Partner operator performs this step from the fleet-management surface. The Forge comes up as a self-contained fastenv instance: the brain store, the source manager, the validation runner, and the deployment controller all start together, seeded with three initial apps — a knowledge base engine, a project management surface, and a CI job orchestrator. The Owner points the Forge at the hosts it may deploy to — which may be the same host the Forge runs on for a first proof of concept, or additional hosts as usage grows. The data store may be local to the Forge host or a managed service the Forge connects to. Once the Forge is up, it is the only system the Owner needs to operate Superfield end to end.

**The Forge improves itself.** The seed apps that come with the Forge — the knowledge base engine, the project management surface, and the CI job orchestrator — are full Superfield apps. They accumulate usage signal, surface gaps, and accept agent-proposed improvements through the same loop as any other app. The Forge self-drives its own construction: agents propose changes to the Forge's own capabilities, humans review and approve them at the outcome level, and the Forge upgrades itself without a separate release process. Over time, the Forge evolves from its seed into the full capability the company needs, shaped by actual usage rather than a fixed product roadmap.

**Requesting a net-new app (the wedge).** A Requestor describes a need their department has no software for. A new workspace is created for that app inside the brain, and agents stand up a working first version against the unified store — born coherent, displacing nothing. Where the app needs data the company maintains, it connects to the relevant systems of record by reading from them, without modifying or replacing them. Each additional app the company requests follows the same path and joins the same brain.

**Stating intent and inferring the spec.** A Steerer states what the software should do, or simply has the team operate it. The behavioral trace of that usage lands in the same store as the goals and the code. An agent reads the trace, infers what the software is actually used for, compares it to the stated goals, and surfaces the delta as a proposed specification. The human confirms or corrects the inference; the specification is continuously revised, never separately authored.

**Proposing and validating a change.** An agent (or human) proposes a change as an isolated fork of the live state. The Forge runs validation — in a fastenv instance provisioned for that job — against a current baseline held in the brain, checking conformance to the architectural and security constraints the brain holds: the **Blueprint**, a versioned rule set that fails closed — a missing or unreadable rule set blocks merging rather than waiving conformance. A change cannot merge until validation passes and any policy-required human approval is given.

**Reviewing and merging.** A Steerer reviews a gated change at the outcome level — the behavior demonstrated against representative data, together with its intent, triggering signal, and a plain-language risk statement — and approves or rejects it. Approvers are never asked to read code diffs. Approved changes merge into the live state; the decision and its rationale are recorded. As the change stream grows, review scales through trust escalation (§9): per-window risk budgets and sampling audits rather than a per-change human queue.

**Deploying and learning.** The Forge deploys a merged, validated change to the target environment — a fastenv instance on a host the Forge can access and observe. Runtime behavior and errors flow back into the brain as new signal, closing the loop. When a production error fires, an agent traverses the chain from error to session to affected users to requirement to current code, produces a grounded diagnosis, and proposes the next change — within minutes, with a human reviewing the change rather than assembling the diagnosis.

**Steering and monitoring from the control panel.** A Steerer drives agent work from the control panel. The primary mode is batch review: agents run to completion and present finished candidate states — variants, before-and-after demonstrations, policy exceptions — and the human chooses among outcomes. A Steerer can also direct an agent on a specific issue, turn a raw idea into a tracked piece of work, and edit the app's documents and plan. An interim live mode — watching an agent work against a live preview of the running app, seeing each step's reasoning, and steering mid-task — remains available while agent runs are slow enough for it to be useful, and is expected to recede as agent speed grows. An Owner monitors every active agent — its task, elapsed time, and cost — and can intervene, escalate, or stop the loop. Both surfaces — the app and the control panel — are reached through one sign-on.

**Designing the experience.** A Steerer or Collaborator reviews the app's components and full screens against representative data while the agent iterates, checks them across device sizes, and compares the experience before and after a change, so the result matches intent before it ships.

**Operating deployments.** An Owner or Administrator views the health of each environment, follows a rollout as it progresses, and rolls a change back if it regresses — all from the control panel, against the same store that holds the change and its validation.

**Governing.** An Owner adjusts policy by selecting or tuning certified templates, and an Auditor inspects history at any time; both act against the same store, with no separate reporting system to reconcile.

## 6. Entity Lifecycle

- **Forge:** provisioned (seed) → active → evolving → suspended → decommissioned. One per company. Arrives with a knowledge base engine, project management surface, and CI job orchestrator as seed apps; self-improves through routine Superfield operation. Hosts the brain, runs validation, and manages deployments for all apps under it.
- **fastenv instance:** requested → running → stopped | replaced. The target execution unit for all Superfield workloads — validation jobs and delivered application instances run as fastenv instances; the Forge itself follows per the scheduled step in §9.
- **Brain (company brain):** provisioned → active → suspended → decommissioned. One per company, inside its Forge; isolated from every other company's brain by the appliance boundary. The knowledge base and transactional record are unified in the same store.
- **Workspace (per-app):** provisioned → active → suspended → decommissioned. The per-app unit of access control inside the brain (see Glossary).
- **App (project):** requested → standing-up → active → archived. Each app gets its own workspace within the company's brain and runs as a fastenv instance on a Forge-accessible host.
- **Intent / requirement:** stated or inferred → confirmed → revised (continuous) → retired.
- **Specification:** inferred → confirmed | corrected → superseded. Always derived from current intent and behavior.
- **Change:** draft → validating → awaiting-approval (when policy requires) → merged | rejected | abandoned.
- **Validation run:** queued → running → passed | failed. Runs in an isolated fastenv instance provisioned by the Forge.
- **Issue:** open → in-progress → resolved | closed.
- **Deployment:** pending → live → rolled-back | superseded.
- **Policy:** template selected → active → revised → retired. Policy enters the system as a certified template the Owner selects and tunes; it is never authored from scratch.

## 7. Integration Needs

Capability categories required (no specific vendors):

- **Read from systems of record** — read-only connection to the company's existing systems so a new app can use data the business maintains, without modifying or replacing those systems.
- **Identity and access management** — authentication and single sign-on for human users, integrating with the identity provider the company already runs, mapped to the role model and shared by both surfaces (the delivered app and the control panel).
- **Host access** — the ability for the Forge to reach, observe, and deploy onto infrastructure the company makes available. The data store may be local to the Forge host or a managed service.
- **Agent execution** — access to large-language-model agent capability that performs the reading, reasoning, and writing.
- **Notification** — the ability to alert a human when a change awaits approval or a signal demands attention.
- **Partner fleet management** — Superfield reaches its customers primarily through MSP/VAR partners. The product must expose a partner-facing surface for provisioning, monitoring, upgrading, and checking the health of every customer appliance a partner operates.

**Triggers:** a new workspace is created when a Requestor requests an app; systems of record are read on demand as an app needs their data; identity is checked on every human action; the Forge provisions a fastenv instance to run a validation job or deploy a merged change; notification fires when policy requires human approval or a high-severity signal appears.

## 8. Out of Scope

- Reproducing the full feature surface of incumbent developer tooling. Only the portion that actually carries development work is in scope; the rest is overhead for a human-paced collaboration model that agents do not need.
- Compatibility with external source forges, CI services, container registries, or GitOps deployment pipelines as required runtime dependencies. The Forge replaces these for the apps it manages; importing from them during initial onboarding is acceptable, but ongoing operation does not depend on them.
- Arbitrary workflow customization. The product encodes one coherent way to run the loop rather than offering configuration knobs.
- Serving as a general-purpose data warehouse or analytics platform for retrospective reporting. The brain synthesizes a current view of the business to decide and steer what software to build — synthesis in service of execution is in scope; reporting and metrics unrelated to the development loop are not.
- Executing operational improvements that are not software. Superfield drives the software slice of operational improvement; where a gap is best closed by process, policy, or people, it may surface the gap but does not implement the fix.
- Modifying, migrating, or replacing the company's existing systems of record. The product enters on net-new apps the business does not have; it does not rip and replace the systems running in production.
- A generic observability or analytics dashboard. The control panel surfaces only what an operator acts on — agent activity, cost, change reasoning, deployment health — not arbitrary metrics for their own sake.
- A configuration surface. The product encodes one coherent way to run the loop; the control panel steers and oversees agents rather than exposing settings to tune.

## 9. Constraints

- **Self-sufficiency.** The Forge is the source manager, CI service, artifact store, and deployment controller for every app it manages — including itself. The core loop — intent, change, validation, review, deploy — completes without a runtime dependency on any external forge, CI service, registry, or GitOps tool. The Forge upgrades itself through the same loop; no external release process is required to evolve it.
- **fastenv execution (target state).** All Superfield workloads — the Forge itself, validation jobs, and delivered application instances — are to run in fastenv, so that no general-purpose container orchestration platform is required. Validation jobs and delivered apps carry this as a requirement; moving the Forge itself into fastenv is explicitly a scheduled later step in the build order, not an assumed present fact.
- **Coherence.** The knowledge base and transactional record are unified in one store, sharing one schema, one clock, and one trust model, so that any fact joins to any related fact without translation. The schema's core is fixed and Superfield-owned — intent, change, validation, deploy, signal — extended per app by agent-authored leaf schemas approved at the outcome level; the core is product, not customer configuration.
- **End-to-end verifiability.** Every change must be traceable from the intent that motivated it through the validation that gated it to the runtime behavior it produced.
- **Validation gate.** No change may merge without passing validation against a current baseline — including conformance to the governed architectural and security constraints the brain holds, not test results alone — and no change above the policy-defined risk threshold may ship without human approval. The governed constraints are held as the **Blueprint**, a versioned rule set in the brain, and the gate fails closed: a missing or unreadable rule set blocks merges rather than waiving them.
- **Outcome-level approval and trust escalation.** Human approval operates at the outcome level: approvers judge behavior demonstrated against representative data, never code diffs. Review must scale with the change stream — per-window autonomous risk budgets and sampling audits rather than a per-change human queue — so that raising autonomy over time is a governed escalation, not a leap of faith. Policy enters the system only as certified templates the Owner selects and tunes.
- **Isolation and access control.** Each company's brain is isolated by the appliance boundary: nothing leaves the appliance, and no data crosses between customers. Within a brain, the per-app workspace is the unit of access control, while facts remain joinable across the brain under its one schema. Access control travels with the data rather than living in a separate system. Because one store concentrates risk, isolation and recoverability are launch-critical.
- **Unified authentication.** Both surfaces — the delivered app and the control panel — must sit behind one shared authentication and access layer, integrated with the identity provider the company already runs and mapped to the role model. A person's identity and permissions must be consistent across both; neither surface may carry a weaker access model than the other.
- **Auditability and governance.** Every agent action, decision, and the reasoning behind it must be recorded and reviewable, to meet the company's compliance and regulatory obligations.
- **Reliability.** The brain must meet system-of-record expectations for availability, backup, and recovery, befitting a store the company's operations depend on.
- **Operability.** Every install, administration, and recovery flow must be performable by a sysadmin-generalist — the person who runs the company firewall and the productivity/identity tenant — through the control panel, at the operational grade of an on-prem NAS or firewall appliance. No operator flow may terminate in a compiler, a shell pipeline, or a config-file edit.
- **Continuous export.** The company must be able to continuously export its estate — source code as a standard git tree, the brain as a portable schema — at any time. Sovereignty and the absence of a hostage problem are product guarantees, not policies.
- **Green-wedge adoption.** The product must enter on a net-new app the business does not have, requiring no change to existing systems of record and no migration. Value must land on a single app before any expansion, and expansion must be additive — each new app joins the same brain without disturbing the company's production systems.

## 10. Open Questions

**Answered (2026-07-02).**

- *What is the minimum policy vocabulary an Owner needs to express autonomy boundaries clearly, without it becoming a configuration surface?* — Answered: policy ships as certified templates the customer selects and tunes (§9). The Owner never authors policy from a blank vocabulary, so no configuration surface arises.
- *How does a company measure trust in autonomous changes well enough to raise the policy threshold over time?* — Answered: trust escalation is a requirement, not a question (§9) — per-window autonomous risk budgets and sampling audits, with autonomy raised as budgets are met and audits stay clean.

**Deferred to the commercial workstream** (owned there; not answered in this PRD).

- What is the read boundary to systems of record — which data must an app read live, and what may it copy into the brain — and how is that boundary governed?
- What data-residency and regulatory boundaries must a single brain honor for a company operating across jurisdictions?

**Open.**

- How is the validation baseline established and trusted for a brownfield system whose existing test coverage may be incomplete?
- Which kinds of backlog apps make the strongest first wedge, and what qualifies a need as "unserved" enough to land on?
- What is the expansion path from the first app to many — when does the shared brain start compounding value across apps, and what could stall that?
- How are conflicting concurrent changes from multiple agents and humans reconciled within the live state?
- When the Forge and an app instance share the same host, what isolation guarantees apply between the Forge's own workloads and the app's runtime behavior? (Tied to the scheduled Forge-in-fastenv step, §9.)

## 11. Glossary

Canonical meanings for terms this document and its companions use. Where another document uses one of these terms differently, this glossary governs.

- **Company (the customer)** — an organization with more than $10M in annual revenue that does not hire full-time engineers; a skeletal technical staff, possibly led by a technical lead under any title (CIO, CTO, COO).
- **Forge** — the installation root; one per company. "Forge," "the appliance," "the daemon," and "the `superfield` binary" name the same thing at different levels: the Forge is the product role, the appliance is its operational posture, and the binary/daemon is the artifact that implements it.
- **Brain (company brain)** — the single unified store inside the Forge: knowledge base and transactional record in one schema, one clock, one trust model. One per company.
- **Workspace** — the per-app unit inside the brain and the unit of access control. Earlier documents sometimes used "workspace" for the whole brain; that usage is retired.
- **Control panel / Studio** — the human steering and oversight surface. "Studio" is the implementation name for the PRD's control panel; they are the same surface. Documents should introduce it as "Studio (the control panel)."
- **Orchestrator** — in this document, only the CI job orchestrator seed app. The word has also named a daemon-control schema and a retired prototype stack elsewhere; those uses must be qualified, never bare.
- **The loop** — the single core loop: intent → change → validation → review → deploy → signal. "Gardening loop" and "loop engine" name its implementation, not a different loop.
- **fastenv** — Superfield's purpose-built execution environment; the target execution unit for all Superfield workloads (§9).
- **Blueprint** — the versioned, fail-closed rule set held in the brain; a binding input to the validation gate (§9).
- **Certified policy template** — a vendor-certified policy the Owner selects and tunes; the only way policy enters the system.
- **Partner (MSP/VAR)** — a managed-service provider or value-added reseller operating appliances on customers' behalf; the primary sales and operations channel.
