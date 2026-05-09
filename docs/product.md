# Superfield — Product Requirements Document

This file is the product-facing scope: what Superfield is, who it's for, what it does for the user, and what's out of scope. Implementation details live in [`architecture.md`](./architecture.md); build order lives in [`roadmap.md`](./roadmap.md); test strategy lives in [`testing.md`](./testing.md).

## Overview

**Superfield is an Agent Integrated Development Environment (Agent IDE).**

Where a traditional IDE helps a human write code, Superfield runs a continuous autonomous loop — planning, coding, testing, reviewing, deploying — driven entirely by AI agents. The developer steers intent; agents do the work.

Superfield is delivered in two phases with a clear architectural divide:

### Phase 1 — Agent Orchestration Platform _(current)_

Four integrated layers that run today:

**Orchestration.** A continuous GitOps dev loop with three concurrent responsibilities: keeping the Plan healthy (CI watchdog, issue audit, blueprint conformance), driving issues through development and merge, and keeping documentation in sync after every merge. Issues are the task queue; the Plan issue is orchestration state; PRs are change proposals. Git and GitHub remain the delivery plane.

**Self-improvement.** Agents learn from their own run history. The planning loop audits past turns, detects drift from the blueprint, and tightens the rules the agents follow over time. This is the same feedback mechanism that makes human engineers get better at a codebase — encoded as an automated loop. Conceptually aligned with [Honcho](https://honcho.dev)'s approach to agent personalization, applied to engineering process rather than user preferences.

**Blueprint (the brain).** Superfield ships with a compiled knowledge graph of architectural rules, security threats, antipatterns, and implementation rules. This is the curriculum the agents are trained against. Dev-loop agents receive a narrow rule slice on turn 1; principles and threats layer in as context expands. Before opening a PR, the agent self-audits its work against the full blueprint. Issues are also checked against the blueprint by the planning loop, which posts rule-cited advisory comments.

**Deploy + Control console.** One-command k3s deployment lifecycle across major cloud providers (GCP, DigitalOcean, AWS, Vultr), plus a browser console that is the single pane of glass for iterative development, UX design, agent monitoring, and deployment health.

### Phase 2 — Self-Improving App Platforms _(planned)_

Phase 1 keeps Git and GitHub as the delivery plane. Phase 2 replaces them with infrastructure purpose-built for agent iteration speed:

**Sharp — agent-native version control.** [`superfield-ai/sharp`](https://github.com/superfield-ai/sharp) is a VCS designed for agent iteration speed while remaining backwards-compatible with Git. Branching-free change tracking, a diff stream and intent log that agents read and act on directly, and merge ceremony only where a human genuinely needs it.

**Nexum — self-improving synthetic corpus.** [`superfield-ai/nexum`](https://github.com/superfield-ai/nexum) generates and continuously refines the synthetic corpus that improves agent skills and product documentation. Where the Phase 1 blueprint is a static knowledge graph authored by hand, Nexum makes it a living curriculum — agents improve the corpus as they work, and the improved corpus makes future agents more capable.

**FastEnv — ultrafast container forking.** Sub-second environment cloning for the CI inner loop. Agents get a fresh, isolated execution environment for every test run without the cost of a full container build. This is the substrate that makes embedded CI practical at agent iteration speeds.

**Self-improving app platforms.** The end goal: applications that continuously audit and improve themselves via the agent loop. Superfield is the runtime that makes autonomous self-modification safe, observable, and reversible — an always-on engineering team running inside the product.

---

## Problem

Autonomous continuous development loops expose the limits of existing tooling. Git and GitHub were designed for human-paced collaboration: branch-per-feature, pull request review, minutes-long CI runs. Agents can iterate at a rate that makes this machinery a bottleneck rather than a feature. Phase 1 works within those constraints; Phase 2 removes them.

At the process level, the earlier superfield-agents skill system required a human (or LLM session) to interpret and direct execution. For autonomous loops this model is too fragile — drift, misinterpretation, and context loss compound. Superfield eliminates this by encoding every skill as a typed TypeScript module with explicit inputs, outputs, and unit tests.

## Guiding Principles

- **Local issue DB as source of truth.** Superfield keeps feature and issue progress in an embedded local database first, then syncs GitHub issues from that record.
- **Forge as delivery plane (Phase 1).** Git and GitHub carry merge state, Plan coordination, and human review. They are not the only store of issue truth. In Phase 2 the forge is replaced by agent-native infrastructure.
- **Blueprint as curriculum.** The knowledge graph is not a linter or a style guide — it is the curriculum the agents are trained against at runtime. Rules are delivered in a pedagogically ordered sequence per turn.
- **Self-improvement loop.** Every completed turn is an opportunity to tighten the rules the agent follows next time. The planning loop closes this feedback cycle automatically.
- **No customization.** There are no workflow flags or configuration knobs. Superfield encodes one correct way to do things.
- **No system binaries.** Never shell out to `git`, `gh`, `curl`, or any other system executable. All git operations go through a TypeScript git library; all GitHub operations go through a TypeScript GitHub API client. The sole exception is agent vendor CLIs (e.g. `claude`, `codex`) — spawned as subprocesses because they are the LLM execution layer, not system utilities.
- **Skills are code.** Each skill is a TypeScript module with an explicit interface, typed inputs/outputs, and unit tests.
- **API-first testing.** Both the git library and the GitHub client are tested via MSW-intercepted API calls and golden response fixtures.

## CLI Commands

Superfield has exactly three operational commands plus github subcommands. There are no flags to modify their behavior.

```
superfield github add       # authenticate, install app, and register the current repo
superfield github forget    # remove credentials and print the app uninstall link

superfield start [slotCount]  # begin the continuous development loop (foreground)
superfield plan             # sync all open issues into the Plan tracking issue
superfield feature          # ticket a new feature issue and update the Plan
```

**`superfield start`** runs a continuous loop with three concurrent responsibilities: keeping the Plan healthy (CI watchdog, issue audit, blueprint conformance), driving issues through development and merge, and keeping documentation in sync on every merge. See [`architecture.md`](./architecture.md#command-start-internals) for details.

**`superfield plan`** is a one-shot replan that audits open issues, groups them into phases, and writes the Plan tracking issue. Safe to run while `start` is active. See [`architecture.md`](./architecture.md#command-plan-internals).

**`superfield feature`** tickets a new feature issue and registers it in the Plan. Safe to run while `start` is active. See [`architecture.md`](./architecture.md#command-feature-internals).

### Concurrency model

`start` can be running in one terminal while `plan` or `feature` is invoked in another. There is no local IPC or shared process state. Coordination happens through the forge: `plan` and `feature` write to GitHub; `start` picks up their changes on the next poll cycle. This is a direct consequence of the forge-as-control-plane design.

---

## Ops Commands

Superfield also owns the full lifecycle of the k3s deployment that the orchestrator runs against. These are operator-facing, one-shot commands — not part of the continuous loop.

```
superfield init <env>          # provision host, register GitHub secrets, and deploy in one shot
superfield doctor <env>        # preflight health check — SSH reachability, k3s, DB, GitHub secrets
superfield deploy-env <env>    # rolling update: build → push → apply manifests → health gate
superfield rollback-env <env>  # roll back to the previous deployment
superfield destroy <env>       # tear down the deployment (prod requires explicit confirmation)
superfield export-db <env>     # dump the database to a local file
```

### Design constraints

- **Per-env secrets.** All host, key, and connection information is stored as GitHub Actions secrets named `DEPLOY_HOST_<ENV>`, `DEPLOY_KEY_<ENV>`, `DATABASE_URL_<ENV>`. No ambient environment variables with bare names.
- **Idempotent.** Every command is safe to re-run. `init` can be interrupted and restarted without duplicating resources.
- **Provider-agnostic.** `init` accepts `--provider` (gcp | digitalocean | aws | vultr). The k3s stack and GitHub wiring are identical across providers; only the VM/DB provisioning step differs.
- **Prod safety gate.** `destroy` refuses to proceed in the `prod` environment without an explicit `--confirm` flag.

### Supported providers

| Provider     | VM  | Managed DB |
| ------------ | --- | ---------- |
| GCP          | ✅  | AlloyDB    |
| DigitalOcean | ✅  | Managed PG |
| AWS          | ✅  | RDS        |
| Vultr        | ✅  | —          |

---

---

## Control Webapp

`superfield control` is the operator-facing browser UI for a Superfield project. It is the **single pane of glass** for iterative development, UX design, agent monitoring, and deployment health. It is not a generic dashboard — every panel is tied to a real Superfield primitive (a turn, an agent slot, a Plan issue, a deployed env, a blueprint rule).

```
superfield control [--port <n>] [--repo <path>] [--api-url <url>]
```

The webapp runs at `http://127.0.0.1:7000` by default. It is read/write against the dev-loop API on `:7837` (analytics + steering) and the forge (commit log, PR / CI status). It does not own state — the forge and the dev-loop process do.

### Audience

- **Builder** — runs the dev loop, watches agents work, steers them mid-turn, ships PRs.
- **Designer** — iterates on components and routes against live fixtures inside an active studio session.
- **Operator** — checks env health, rolls deployments forward, rolls back.

The same person is often all three. The webapp is laid out so a single demo can move through all three pillars without leaving the page.

### The four pillars

#### 1. Iterative development (the studio session)

What the page is _for_: writing a turn, watching the agent work, seeing the result in the iframe, committing or rolling back. This is the default landing view.

| Capability                                                       | Status |
| ---------------------------------------------------------------- | ------ |
| Mode-driven chat panel ↔ agent (`steer` / `feature` / `product`) | ✅     |
| App iframe with cluster-status-aware reload overlay              | ✅     |
| Mid-turn steer (`POST /steer/context` via `/studio/steer`)       | ✅     |
| Commit log + checkpoint timeline + rollback                      | ✅     |
| Per-turn file diff inline in chat                                | ⬜     |
| Per-route preview map (sidebar: app routes → click to load)      | ✅     |
| Fixture switcher (per-route, persisted in `.studio/`)            | ✅     |
| Viewport toolbar (mobile / tablet / desktop) on iframe           | ✅     |
| Screenshot capture per turn (saved to `studio-sessions/`)        | ⬜     |

##### Chat workflow

The chat composer is a mode-driven command surface, not a generic chat box.

- The composer has a three-position toggle: `steer`, `feature`, `product`.
- `steer` is issue-scoped. The user cannot switch into `steer` manually unless they first select an issue from the running-agent list.
- The adjacent panel shows the running developer agents for the current repository and groups them by issue.
- Each issue row expands as an accordion to reveal the issue body and its checklist items.
- Selecting an issue from the list switches the composer into `steer` for that issue and routes prompts to the Superfield API for that specific agent session.
- `feature` is the interactive issue-scoping mode. It is used to turn an idea into a properly formatted local issue record, persist it to the embedded DB, and sync the corresponding GitHub issue and PR metadata.
- `product` is the documentation and planning mode. It is used to read and explain `./docs`, update product and planning documents, and open PRs for those doc changes.

#### 2. UX design (`/studio/preview`)

What the page is _for_: a designer reviewing components and mock routes against fixture data while the agent iterates. Lives at `/studio/preview` and is only mounted when studio mode is active.

| Capability                                                 | Status |
| ---------------------------------------------------------- | ------ |
| Component preview panel (isolated render, fixtures)        | ✅     |
| WikiRender + CitationHoverPopover                          | ✅     |
| Mock-route gallery (full-page views with fixture data)     | ✅     |
| Design-tokens panel (palette, type, spacing, shadows)      | ✅     |
| Responsive viewport toolbar                                | ✅     |
| Visual diff before / after a turn (latest commit baseline) | ⬜     |
| Deep-link to chat: "edit this component" prefilled         | ⬜     |

#### 3. Agent monitoring (`/studio/orchestrator`)

What the page is _for_: an operator running the dev loop, watching all slots, intervening when a session goes off-rails. Sourced from `/analytics/*` on `:7837`.

| Capability                                                          | Status |
| ------------------------------------------------------------------- | ------ |
| Process controls (Start / Stop dev loop child process)              | ✅     |
| Loop status bar (plan / dev / doc — last tick, duration, circuit)   | ✅     |
| Active slots list (issue, role, backend, elapsed, heartbeat)        | ✅     |
| Cost summary (USD total, per-backend, agent count, error count)     | ✅     |
| Steer + Escalate buttons per slot                                   | ✅     |
| Dev-loop log tail (SSE, ring buffer)                                | ✅     |
| Turn timeline per session (turn 1..N — start, end, tokens, cost)    | ✅     |
| Prompt/response inspector (click a turn → see prompt + tool calls)  | ✅     |
| Blueprint conformance feed (last N rule citations posted to issues) | ✅     |
| Cost-over-time sparkline (per session and per loop)                 | ⬜     |
| Log search + level filter (info / warn / error / agent-stdout)      | ⬜     |
| Slot heartbeat history (sparkline, last 60 ticks)                   | ⬜     |

#### 4. Deployment health (`/studio/deploy`)

What the page is _for_: an operator deploying or triaging dev / staging / prod. Backed by `superfield doctor`, `deploy-env`, `rollback-env` over a thin HTTP wrapper. **New panel — not yet built.**

| Capability                                                                             | Status |
| -------------------------------------------------------------------------------------- | ------ |
| Cluster status indicator (current env)                                                 | ✅     |
| Rebuild + rollout restart trigger                                                      | ✅     |
| Per-env doctor matrix (SSH / k3s / DB / secrets — green/red per env)                   | ⬜     |
| Rolling-deploy progress strip (build → push → apply → health gate)                     | ⬜     |
| Rollback button surfaced (calls `rollback-env` with confirmation)                      | ⬜     |
| k3s pod / Job status table (control-plane, postgres, migration Job)                    | ⬜     |
| Latest-PR / CI-on-`main` strip (green/red, click → forge)                              | ⬜     |
| Secrets-presence audit (`DEPLOY_HOST_<ENV>`, `DEPLOY_KEY_<ENV>`, `DATABASE_URL_<ENV>`) | ⬜     |
| Last DB-migration Job log tail                                                         | ✅     |

### Non-goals

- **Multi-user collaboration.** One operator at a time. No presence, no comments, no role-based access.
- **Generic observability.** This is not a Grafana replacement. Every metric we surface is one a Superfield operator acts on.
- **Configuration UI.** Superfield encodes one correct way to do things — there are no settings panels.
- **Production-grade auth.** The webapp inherits the studio session JWT cookie. Anyone who can reach `:7000` has full access. It is intended for an operator's own machine or a tunneled session.

### Out of scope for the 48-hour demo

The pillars 1–4 above describe the destination. The demo cut targets the gaps marked highest-impact in `TASKS.md` (per-route preview map, design-tokens panel, deployment health matrix, turn timeline). Everything else stays as-is.

---

## Out of Scope

### Phase 1

- Slack / webhook notifications
- Forges other than GitHub
- Self-hosted LLM backends (Claude and Codex CLIs are supported)
- Multi-tenant / multi-user control webapp (single-operator only)
- Agent-native version control or embedded CI (Phase 2)

### Entire roadmap

- Generic observability (not a Grafana replacement — every metric surfaced is one an operator acts on)
- Configuration UI (Superfield encodes one correct way to do things)

---

## Open Questions

1. **Plan issue ownership**: always created under `assignedUser`'s token, or is there ever a separate service account concept?
