# Superfield — Product Requirements Document

## Overview

Superfield is an opinionated GitOps AI orchestrator. Git and the forge (GitHub initially) are the control plane — not a side effect. Issues are the task queue. The Plan issue is orchestration state. PRs are change proposals. Superfield reads from and writes to this control plane to drive autonomous development loops.

It replaces calypso-agents entirely, re-encoding every skill and workflow as TypeScript. Hard type contracts and deterministic code replace the soft guardrails of LLM-interpreted markdown prompts. The result is a self-contained, testable runtime that treats the forge as the single source of truth for all agent state.

## GitOps Control Plane

All orchestration state lives in the forge, not on disk or in memory:

| Control plane primitive | Role |
|---|---|
| Plan issue | Ordered work queue; the orchestrator's view of what to do next |
| Feature / fix issues | Units of work; each issue is one agent assignment |
| Pull requests | Change proposals; merge = issue closed = work done |
| Check runs | CI signal; failure = new work item enters the queue |
| Issue labels | State machine transitions (e.g. `ci-failure`, `watchdog`) |
| Issue comments | Agent-to-agent and agent-to-human communication |

Superfield is stateless at the process level. Any instance can resume from the forge alone. Killing and restarting the process loses nothing.

## Problem

The calypso-agents skill system requires a human (or LLM session) to interpret and direct execution. For autonomous continuous loops this model is too fragile: drift, misinterpretation, and context loss compound over time. Shell scripts add a second failure surface — they depend on system binaries, environment state, and implicit PATH. Superfield eliminates both: skills become typed TypeScript modules, all external interaction goes through direct API calls, and the forge owns all state.

## Architecture

Superfield is a direct replacement for the calypso-agents + shell script stack:

| calypso-agents concept | Superfield equivalent |
|---|---|
| Markdown skill (`SKILL.md`) | TypeScript skill module with typed I/O |
| Shell script (`.agents/scripts/`) | TypeScript function (no subprocess, no binary) |
| `calypso-auto` orchestrator loop | `superfield start` |
| `calypso-feature` + `feature-evaluate` | `superfield feature` |
| Plan rebuild / replan | `superfield plan` |
| Plan issue (GitHub) | Plan issue (GitHub, same format) |

## Guiding Principles

- **Forge as control plane.** Git and GitHub are the source of truth for all agent state, task ordering, and communication.
- **No customization.** There are no workflow flags or configuration knobs. Superfield encodes one correct way to do things.
- **No system binaries.** Never shell out to `git`, `gh`, `curl`, or any other executable. All git operations go through a TypeScript git library; all GitHub operations go through a TypeScript GitHub API client.
- **Skills are code.** Each calypso-agents skill is a TypeScript module with an explicit interface, typed inputs/outputs, and unit tests.
- **API-first testing.** Both the git library and the GitHub client are tested extensively via MSW-intercepted API calls and golden response fixtures.

## Libraries

| Concern | Library |
|---|---|
| GitHub API | `@octokit/rest` — typed REST client, first-class TS support |
| Git operations | `isomorphic-git` — pure JS/TS git, no binary dependency |
| HTTP interception (tests) | `msw` — intercepts at the `fetch` level, covers both libraries |

---

## CLI Commands

Superfield has exactly three operational commands plus setup. There are no flags to modify their behavior.

```
superfield setup         # add a GitHub user (handle + PAT)
superfield repo add      # register a repository and assign it to a user

superfield start         # begin the continuous development loop (foreground)
superfield plan          # sync all open issues into the Plan tracking issue
superfield feature       # ticket a new feature issue and update the Plan
```

### Concurrency model

`start` can be running in one terminal while `plan` or `feature` is invoked in another. There is no local IPC or shared process state. Coordination happens through the forge: `plan` and `feature` write to GitHub; `start` picks up their changes on the next poll cycle. This is a direct consequence of the forge-as-control-plane design.

---

## Planning Model

Understanding the planning model is prerequisite to understanding `start` and `plan`.

### Phases

Work is chunked into **phases** — logical groupings of issues that share a delivery goal. A phase has:
- A human-readable name and goal
- Zero or more prerequisite phases (`depends_on`)
- Exactly one **dev-scout** issue placed first
- Zero or more feature implementation issues

All issues in prerequisite phases must close before the scout of a dependent phase may begin.

### Dev-scout

The first issue in every phase is a **dev-scout** — a stub-only integration pass. The scout does not implement real behavior. It:
- Creates no-op stubs for all planned entrypoints, seams, and interfaces
- Compiles and passes tests without changing runtime behavior
- Documents integration points and risks discovered during the pass
- Posts follow-up comments on downstream issues with findings

**The scout gates the entire phase.** No non-scout issue in a phase may begin until the scout PR is merged and its follow-up updates are complete. This is enforced by explicit dependencies in the Plan, not by convention.

### Dependencies

Dependencies live in the Plan JSON, not in issue bodies. Each issue in the Plan carries:

```typescript
interface PlanIssue {
  number: number;
  title: string;
  phase: string;
  kind: "dev-scout" | "feature" | "ci-failure";
  risk: number;           // 1–6
  dependencies: number[]; // issue numbers that must be CLOSED first
  dependents: number[];
  parallel_safe: boolean; // true if all dependencies are CLOSED
}
```

Validation rules (enforced at plan-write time, not runtime):
- All dependency references exist in the ordered issue list
- All dependencies appear strictly earlier in the list than the issue depending on them
- Every non-scout issue in a phase depends on its phase's scout
- Phase-level dependency edges are acyclic

### Parallelization and merging

Development runs in parallel; merging is strictly sequential.

**Slots:**
- **Slot 1 — primary**: always the highest-priority unmerged Plan issue. The primary agent drives implementation → CI → checklist → merge without stopping. It does not exit until the PR is merged and the issue is CLOSED.
- **Slots 2..N — speculative**: issues whose dependencies are all CLOSED (eligible for early work). Speculative agents drive implementation and checklist to completion, mark the PR ready, then exit immediately to free the slot. They do not wait for CI and do not merge.

**Sequential merge invariant**: a PR may only merge when all preceding Plan issues are CLOSED. After each merge the queue advances and any newly unblocked speculative PRs become eligible to merge.

Default: 1 primary + 2 speculative (3 total slots).

---

## Command: `start`

The continuous development loop. Runs indefinitely until killed (Ctrl-C).

`start` has two concurrent loops:

### Outer loop — repository health (every 5 seconds)

1. **CI watchdog** — query Check Runs for the latest commit on `main`. On any failed check, create a `ci-failure` issue and append it to the Plan (deduplicated by SHA + check name).
2. **Issue audit** — scan all open issues for schema conformance (required sections present, correct labels). Flag non-conforming issues with a label and a comment describing what is missing.
3. **Plan coverage** — verify every open issue is referenced in the Plan. Append any missing issue in dependency order.

The outer loop feeds the Plan. It does not perform development work.

### Inner loop — development (Plan-driven)

1. **Merge phase** — iterate open PRs in Plan order. For each: check merge readiness (CI green, checklist complete, all predecessors CLOSED). Merge when ready. After each merge, restart from the top. Stop when no PR is mergeable.
2. **Select phase** — run `parallel-eligible` logic against the Plan. Identify the primary issue (slot 1) and up to 2 speculative issues (slots 2–3). If no primary: all Plan issues are CLOSED — stop.
3. **Prep phase** — for each selected issue, prepare a dedicated worktree via `isomorphic-git` API calls (no `git` binary).
4. **Launch phase** — dispatch one LLM agent per slot in parallel. Primary agent owns the issue through merge. Speculative agents exit after marking their PR ready.
5. After the primary agent completes, loop back to step 1.

The outer loop and inner loop run concurrently within the same process. The outer loop feeds the Plan; the inner loop drains it.

---

## Command: `plan`

A one-shot replan. Does not start a loop.

1. **Audit** — scan all open issues and PRs for schema compliance (required sections, correct labels, one PR per issue). Flag violations; normalize where safe (non-destructive: add missing sections with defaults, never overwrite existing content).
2. **Collect** — fetch all open issues, their current states, and existing Plan structure.
3. **Evaluate** (LLM call) — assess PRD fit, infer dependencies and code-coupling risks, group issues into coherent phases, assign each phase a dev-scout (create a stub spec if no scout issue exists yet), produce a fully ordered issue list with risk scores.
4. **Create scouts** — for any phase whose scout issue does not yet exist, create the GitHub issue from the scout spec emitted in step 3.
5. **Validate** — run the full Plan JSON schema validation: no duplicate issues, all dependency edges backward, each phase has exactly one scout first, phase dependency graph is acyclic.
6. **Apply** — render the Plan body from validated JSON and write it to the Plan tracking issue.

The rendered Plan body format:

```markdown
## Phase: Identity foundation

Goal: Create the auth and session seams needed by all identity work.
Depends on phases: None.
Scout gate: #196

- #196 — [dev-scout] stub identity integration seams [risk: 5]
  <!-- calypso: {"number":196,"phase":"Identity foundation","kind":"dev-scout","dependencies":[],"parallel_safe":true} -->
- #201 — feat: build user authentication [risk: 4]
  <!-- calypso: {"number":201,"phase":"Identity foundation","kind":"feature","dependencies":[196],"parallel_safe":false} -->
```

Rules: strict total order, no checkboxes, no step numbers, no parallel group annotations. Dependency data lives in the inline `<!-- calypso: ... -->` metadata comments, not in issue bodies.

`plan` is safe to run while `start` is active — it only writes to the Plan issue, which `start` re-reads on the next inner loop cycle.

---

## Command: `feature`

Tickets a new feature issue and registers it in the Plan.

1. Prompt the user for a feature description (stdin or argument).
2. Load current Plan and open issues as context.
3. Run the feature-evaluate skill (LLM call): assess PRD fit, detect duplicates, determine phase and dependencies, emit a typed `FeatureIssue` object.
4. Render the issue body from the typed object.
5. Create the GitHub issue.
6. Append the new issue to the Plan in the correct phase position.

`feature` is safe to run while `start` is active — it writes a new issue and appends to the Plan; `start` will pick it up on the next inner loop cycle.

---

## Issue Schema

All issues created by Superfield are constructed from typed objects, never raw template strings. The `IssueBody` type is the TypeScript equivalent of calypso-agents' `feature-evaluate` JSON output contract.

```typescript
interface IssueBody {
  title: string;
  phase: string;
  issue_kind: "feature" | "dev-scout" | "ci-failure";
  canonical_docs: string[];
  motivation: string;
  behaviour: string;
  scope: { in: string[]; out: string[] }; // explicit for dev-scout; prose for feature
  acceptance_criteria: string[];
  test_plan: string[];
}
```

Rendered issue body:

```markdown
## Issue type
<issue_kind>

## Phase
<phase>

## Motivation
<motivation>

## Canonical docs
- <url>

## Deliverables
- [ ] ...

## Acceptance Criteria
- [ ] ...

## Test Plan
- [ ] ...
```

---

## Plan Issue

One open issue per repository titled `Plan`. Written and owned by Superfield; humans read and comment but do not edit the body.

Structure when phases are present:

```markdown
## Phase: <name>

Goal: <goal>
Depends on phases: <names or "None.">
Scout gate: #<scout_issue_number>

- #<n> — [dev-scout] <title> [risk: <1-6>]
  <!-- calypso: {"number":<n>,"phase":"...","kind":"dev-scout","dependencies":[],"parallel_safe":true} -->
- #<n> — <title> [risk: <1-6>]
  <!-- calypso: {"number":<n>,"phase":"...","kind":"feature","dependencies":[...],"parallel_safe":false} -->
```

Rules:
- Strict total order — no checkboxes, no step numbers, no parallel group annotations
- Scout always first within its phase
- All issues in a prerequisite phase appear before all issues in the dependent phase
- Dependency data lives in inline `<!-- calypso: ... -->` metadata comments, not in issue bodies
- `start` reads the metadata comments to drive the inner loop; the human-readable lines are for humans

---

## Configuration

Stored as plaintext YAML at `~/.superfield/config.yaml`.

```yaml
users:
  - handle: octocat
    token: ghp_xxxxxxxxxxxx

repositories:
  - owner: my-org
    repo: my-repo
    assignedUser: octocat
```

Multiple users and repositories are supported. Each repository is assigned to one user; that user's token is used for all API calls against that repository.

---

## Testing Strategy

Both `@octokit/rest` and `isomorphic-git` make HTTP calls under the hood. MSW intercepts at the `fetch` level, so both libraries are covered by the same interception layer.

### Golden Responses

Real API responses are recorded to `tests/fixtures/` as JSON:

```
tests/fixtures/
  github/    # GitHub REST API responses (check runs, issues, PRs, etc.)
  git/       # git HTTP smart protocol responses (clone, fetch, push)
```

These files are the source of truth for MSW handlers. A recorder (not run in CI) hits real endpoints and writes fixtures. Fixtures are committed and updated deliberately.

### Test Layers

**Unit** — single function or skill module, all network calls mocked via fixtures.

**Integration** — multiple modules composed together (e.g. outer loop: poll → failed check → create issue → update Plan), network mocked, real TypeScript execution.

No tests against real GitHub in Phase 1.

### Coverage Targets

| Scenario | Layer |
|---|---|
| Outer loop: no failures — nothing created | Unit |
| Outer loop: check failed — issue created, Plan updated | Integration |
| Outer loop: duplicate failure — no second issue | Unit |
| Outer loop: non-conforming issue — label + comment added | Unit |
| Outer loop: issue missing from Plan — appended | Unit |
| `plan`: all issues present in Plan body | Integration |
| `plan`: missing issues appended in phase order | Unit |
| `feature`: duplicate detected — user warned, no issue created | Unit |
| `feature`: new issue created and appended to Plan | Integration |
| Plan absent — created on first write | Unit |
| Multiple repos, each with own assigned user | Unit |
| `superfield setup` writes config correctly | Unit |
| Octokit: endpoint, auth header, request shape | Unit |
| `isomorphic-git`: fetch, HEAD resolution, branch lookup | Unit |

---

## Roadmap

| Phase | Scope |
|---|---|
| 1 | `setup`, `repo add`, `start` outer loop only (CI watchdog + issue audit + plan coverage) |
| 2 | `plan` command; `start` inner loop (development agent, calypso-auto equivalent) |
| 3 | `feature` command |
| 4 | Full LLM agent integration within the inner loop |

Phase 1 establishes the foundation — config, GitHub client, git client, issue rendering, Plan management — that all later phases build on.

---

## Out of Scope (Phase 1)

- LLM calls of any kind
- `superfield plan` and `superfield feature` commands
- Inner development loop (agent assignment, worktree management, PR creation)
- Slack / webhook notifications
- Web UI

---

## Open Questions

1. **Deduplication scope for CI failures**: by (SHA + check name) — one issue per failing commit — or by (check name on current HEAD) — one open issue per flaky check regardless of how many commits it has failed on?
2. **Plan issue ownership**: always created under `assignedUser`'s token, or is there ever a separate service account concept?
