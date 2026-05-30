# Product Requirements Document

> Canonical product requirements for Superfield. This document supersedes `product.md` as the product-facing source of truth. Implementation and vendor choices are out of scope here by design — see `architecture.md`. The product thesis is articulated in [`vision/unified-memory-layer.md`](./vision/unified-memory-layer.md).

## 1. Problem Statement

Every large enterprise carries an unserved build backlog: the internal and departmental software it needs but never builds. A team needs a tool to track a process, reconcile two systems, automate a manual workflow, or give a business unit a purpose-built app. Each request is real and funded in principle, but it loses the prioritization fight against the roadmap, so it never ships. The work falls back to spreadsheets, manual process, brittle no-code patches, or a ticket that sits in a queue for quarters. There is no off-the-shelf product to buy, because each of these apps is specific to the business. The demand is large, the budget for IT and automation exists, and the backlog only grows.

The backlog persists because the traditional cost of building, _product-managing_, and _maintaining_ a small bespoke application is too high to justify against its individual value. Building it the conventional way scatters its life across disconnected systems — source in one place, issues in another, validation on a server fleet, runtime errors in an observability tool, the spec in a document nobody updates. A human can cross those boundaries; an autonomous agent cannot, because it reads the stale fact with the same confidence as the fresh one. So the distance from a signal to a corrective change stays measured in days or weeks, and a small app is never worth that overhead. The backlog is the visible symptom of a structural cost problem.

Superfield attacks the backlog by collapsing that cost. Each new app is born inside a single **company brain** — one coherent store holding its source code, changes, validation results, issues, specifications, documents, and runtime behavior together — and agents build and continuously improve it against that store, steered by the requesting team. The same store also gives the business a synthesized, continuously current view of itself, and the operational gaps that view surfaces become the next apps the brain builds. Each app is operated first by the people who requested it — whose usage becomes signal — and, over time, by agents themselves. Because each app is net-new, Superfield enters the enterprise as a **green wedge**: it builds software the business does not have and no incumbent system covers, displacing nothing and requiring no rip-and-replace. It lands on one unserved need, proves itself, and expands as more of the backlog moves into the brain — each additional app cheaper and more legible than the last because they share one coherent ground truth.

For every app it builds, Superfield delivers two surfaces:

- **The application** the business asked for — the running webapp used by its intended audience.
- **The control panel** — the surface through which humans steer the agents building and improving that app: writing intent, watching agents work against a live preview, reviewing and approving changes, monitoring agent activity and cost, designing the experience, and overseeing deployment health.

Both surfaces sit behind **one shared authentication and access layer**, mapped to the same roles, so that a person's identity and permissions are consistent whether they are using the app or governing the agents that build it.

## 2. Goals and Success Metrics

**Goals**

- Let an enterprise ship the net-new internal and departmental apps it would otherwise leave in the backlog, at a cost per app low enough to justify building them.
- Give each app a single, coherent source of truth that humans and agents reason against without crossing system boundaries.
- Close the loop from signal to corrective action so it runs at the speed data updates, not at the speed of human hand-offs — making each app self-maintaining rather than a maintenance liability.
- Let agents perform the development work — proposing, validating, and shipping changes — that humans steer and approve rather than execute.
- Enter on a single unserved need without rip-and-replace, and expand as more of the backlog moves into the brain.

**Success metrics**

- **Time to first app:** time from adoption to a first backlog app shipped and in use is measured in days, not quarters.
- **Backlog throughput:** the number of previously-unserved apps an enterprise ships per quarter rises, and the per-app cost to build and maintain falls.
- **Signal-to-correction time:** median time from a signal (a user behavior, an error) to a reviewed, deployable corrective change drops from days to minutes.
- **Self-maintenance:** the share of an app's corrective changes proposed and validated by agents, with humans only approving, rises over time.
- **Expansion:** the number of apps living in the brain per enterprise grows after the initial wedge.
- **Reliability:** the brain meets enterprise expectations for availability, recoverability, and auditability of every change.

## 3. User Roles

- **Owner / Sponsor** — the IT or platform stakeholder accountable for adoption across the enterprise. Sets policy: what counts as a valid correction, what risk level may ship without human review, and what requires sign-off.
- **Requestor (business unit)** — the department that owns an unserved need, requests an app to address it, and operates that app once it exists so its usage becomes signal.
- **Steerer (Product/Engineering lead)** — directs agent work by stating intent and confirming or correcting the agent's inference of intent. Reviews and approves gated changes.
- **Collaborator** — proposes and reviews changes within a workspace, and operates the software so its behavior becomes signal.
- **Agent** — a first-class, non-human actor that reads the entire brain and writes observations, candidate changes, validation results, and outcomes, acting only within the policy set by the Owner.
- **Auditor / Compliance reviewer** — read-only access to the full history of changes, decisions, and the reasons behind them, for governance and regulatory review.
- **Viewer** — read-only access to project state.

## 4. User Stories

- As an **Owner**, I want to set the policy that governs which changes agents may ship autonomously and which require human approval, so that autonomy stays within the risk tolerance of the business.
- As an **Owner**, I want every agent action and decision recorded with its reasoning, so that I can demonstrate control and accountability to auditors and regulators.
- As a **Steerer**, I want to express what I want the software to do and have an agent infer the rest from how the software is actually used, so that I steer intent instead of authoring detailed specifications.
- As a **Steerer**, I want to review a proposed change together with the full chain of reasoning behind it — the intent, the error, the affected users, the validation — so that I can approve or reject with confidence in one place.
- As a **Steerer**, I want to watch an agent work against a live preview of the app and correct it mid-task, so that I can keep it on course without waiting for it to finish.
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

**Requesting a net-new app (the wedge).** A Requestor describes a need their department has no software for. A new workspace is created for that app inside the brain, and agents stand up a working first version against the unified store — born coherent, displacing nothing. Where the app needs data the enterprise maintains, it connects to the relevant systems of record by reading from them, without modifying or replacing them. Each additional app the enterprise requests follows the same path and joins the same brain.

**Stating intent and inferring the spec.** A Steerer states what the software should do, or simply has the team operate it. The behavioral trace of that usage lands in the same store as the goals and the code. An agent reads the trace, infers what the software is actually used for, compares it to the stated goals, and surfaces the delta as a proposed specification. The human confirms or corrects the inference; the specification is continuously revised, never separately authored.

**Proposing and validating a change.** An agent (or human) proposes a change as an isolated fork of the live state. The change is validated on demand — locally, or on federated machines when capacity is needed — against a current baseline held in the same store, and checked for conformance to the architectural and security constraints the brain holds. A change cannot merge until validation passes and any policy-required human approval is given.

**Reviewing and merging.** A Steerer reviews a gated change together with its full reasoning chain and approves or rejects it. Approved changes merge into the live state; the decision and its rationale are recorded.

**Deploying and learning.** A merged, validated change is deployed to the target environment. Runtime behavior and errors flow back into the brain as new signal, closing the loop. When a production error fires, an agent traverses the chain from error to session to affected users to requirement to current code, produces a grounded diagnosis, and proposes the next change — within minutes, with a human reviewing the change rather than assembling the diagnosis.

**Steering and monitoring from the control panel.** A Steerer drives agent work from the control panel through three modes: directing an agent on a specific issue, turning a raw idea into a tracked piece of work, and editing the app's documents and plan. They watch the agent work against a live preview of the running app, see each step's reasoning and the resulting change, and steer mid-task. An Owner monitors every active agent — its task, elapsed time, and cost — and can intervene, escalate, or stop the loop. Both surfaces — the app and the control panel — are reached through one sign-on.

**Designing the experience.** A Steerer or Collaborator reviews the app's components and full screens against representative data while the agent iterates, checks them across device sizes, and compares the experience before and after a change, so the result matches intent before it ships.

**Operating deployments.** An Owner views the health of each environment, follows a rollout as it progresses, and rolls a change back if it regresses — all from the control panel, against the same store that holds the change and its validation.

**Governing.** An Owner adjusts policy and an Auditor inspects history at any time; both act against the same store, with no separate reporting system to reconcile.

## 6. Entity Lifecycle

- **Workspace (company brain):** provisioned → active → suspended → decommissioned. Isolated from every other workspace.
- **App (project):** requested → standing-up → active → archived. Each app gets its own workspace within the enterprise's brain.
- **Intent / requirement:** stated or inferred → confirmed → revised (continuous) → retired.
- **Specification:** inferred → confirmed | corrected → superseded. Always derived from current intent and behavior.
- **Change:** draft → validating → awaiting-approval (when policy requires) → merged | rejected | abandoned.
- **Isolated environment:** requested → provisioned → active → torn down.
- **Validation run:** queued → running → passed | failed.
- **Issue:** open → in-progress → resolved | closed.
- **Deployment:** pending → live → rolled-back | superseded.
- **Policy:** drafted → active → revised → retired.

## 7. Integration Needs

Capability categories required (no specific vendors):

- **Read from systems of record** — read-only connection to the enterprise's existing systems so a new app can use data the business maintains, without modifying or replacing those systems.
- **Federated compute** — the ability to run validation jobs on remote machines when local capacity is insufficient.
- **Identity and access management** — enterprise-grade authentication and single sign-on for human users, mapped to the role model and shared by both surfaces (the delivered app and the control panel).
- **Deployment targets** — the ability to ship the application to the enterprise's chosen hosting environments.
- **Agent execution** — access to large-language-model agent capability that performs the reading, reasoning, and writing.
- **Notification** — the ability to alert a human when a change awaits approval or a signal demands attention.

**Triggers:** a new workspace is created when a Requestor requests an app; systems of record are read on demand as an app needs their data; federated compute is requested when a validation run exceeds local capacity; identity is checked on every human action; deployment runs on a merged, validated change; notification fires when policy requires human approval or a high-severity signal appears.

## 8. Out of Scope

- Reproducing the full feature surface of incumbent developer tooling. Only the portion that actually carries development work is in scope; the rest is overhead for a human-paced collaboration model that agents do not need.
- A permanent dependency on external continuous-integration services or external forges to complete the core loop. These may be imported from, but the core loop is self-sufficient.
- Arbitrary workflow customization. The product encodes one coherent way to run the loop rather than offering configuration knobs.
- Serving as a general-purpose data warehouse or analytics platform for retrospective reporting. The brain synthesizes a current view of the business to decide and steer what software to build — synthesis in service of execution is in scope; reporting and metrics unrelated to the development loop are not.
- Executing operational improvements that are not software. Superfield drives the software slice of operational improvement; where a gap is best closed by process, policy, or people, it may surface the gap but does not implement the fix.
- Modifying, migrating, or replacing the enterprise's existing systems of record. The product enters on net-new apps the business does not have; it does not rip and replace the systems running in production.
- A generic observability or analytics dashboard. The control panel surfaces only what an operator acts on — agent activity, cost, change reasoning, deployment health — not arbitrary metrics for their own sake.
- A configuration surface. The product encodes one coherent way to run the loop; the control panel steers and oversees agents rather than exposing settings to tune.

## 9. Constraints

- **Self-sufficiency.** The core loop — intent, change, validation, review, deploy — must complete without a hard dependency on any external forge or continuous-integration service.
- **Coherence.** Operational facts and knowledge must share one schema, one clock, and one trust model, so that any fact joins to any related fact without translation.
- **End-to-end verifiability.** Every change must be traceable from the intent that motivated it through the validation that gated it to the runtime behavior it produced.
- **Validation gate.** No change may merge without passing validation against a current baseline — including conformance to the governed architectural and security constraints the brain holds, not test results alone — and no change above the policy-defined risk threshold may ship without human approval.
- **Isolation and access control.** Each enterprise workspace is isolated from every other, and access control travels with the data rather than living in a separate system. Because one store concentrates risk, isolation and recoverability are launch-critical.
- **Unified authentication.** Both surfaces — the delivered app and the control panel — must sit behind one shared, enterprise-grade authentication and access layer mapped to the role model. A person's identity and permissions must be consistent across both; neither surface may carry a weaker access model than the other.
- **Auditability and governance.** Every agent action, decision, and the reasoning behind it must be recorded and reviewable, to meet enterprise compliance and regulatory obligations.
- **Reliability.** The brain must meet enterprise expectations for availability, backup, and recovery, befitting a system of record a large business depends on.
- **Green-wedge adoption.** The product must enter on a net-new app the business does not have, requiring no change to existing systems of record and no migration. Value must land on a single app before any expansion, and expansion must be additive — each new app joins the same brain without disturbing the enterprise's production systems.

## 10. Open Questions

- What is the minimum policy vocabulary an Owner needs to express autonomy boundaries clearly, without it becoming a configuration surface?
- How is the validation baseline established and trusted for a brownfield system whose existing test coverage may be incomplete?
- Which kinds of backlog apps make the strongest first wedge, and what qualifies a need as "unserved" enough to land on?
- What is the read boundary to systems of record — which data must an app read live, and what may it copy into the brain — and how is that boundary governed?
- What is the expansion path from the first app to many — when does the shared brain start compounding value across apps, and what could stall that?
- How are conflicting concurrent changes from multiple agents and humans reconciled within the live state?
- What data-residency and regulatory boundaries must a single workspace honor for a multinational enterprise?
- How does an enterprise measure trust in autonomous changes well enough to raise the policy threshold over time?
