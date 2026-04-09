# Superfield — Architecture

Technical and implementation details for Superfield. Product scope lives in [`product.md`](./product.md); build order lives in [`roadmap.md`](./roadmap.md); test strategy lives in [`testing.md`](./testing.md).

## GitOps Control Plane

All orchestration state lives in the forge. The only local state is `~/.superfield/config.yaml` (credentials and repo assignments) — everything else is in the forge:

| Control plane primitive | Role                                                           |
| ----------------------- | -------------------------------------------------------------- |
| Plan issue              | Ordered work queue; the orchestrator's view of what to do next |
| Feature / fix issues    | Units of work; each issue is one agent assignment              |
| Pull requests           | Change proposals; merge = issue closed = work done             |
| Check runs              | CI signal; failure = new work item enters the queue            |
| Issue labels            | State machine transitions (e.g. `ci-failure`, `watchdog`)      |
| Issue comments          | Agent-to-agent and agent-to-human communication                |

Superfield is stateless at the process level. Any instance can resume from the forge alone. Killing and restarting the process loses nothing. The sole local exception is `~/.superfield/config.yaml` (credentials and repo assignments). All orchestration state — including active agent sessions — lives in the forge.

## Calypso Mapping

Superfield is a direct replacement for the calypso-agents + shell script stack:

| calypso-agents concept                 | Superfield equivalent                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| Markdown skill (`SKILL.md`)            | TypeScript skill module with typed I/O                                                  |
| Shell script (`.agents/scripts/`)      | TypeScript function; agent vendor CLIs (e.g. `claude`, `codex`) spawned as subprocesses |
| `calypso-auto` orchestrator loop       | `superfield start`                                                                      |
| `calypso-feature` + `feature-evaluate` | `superfield feature`                                                                    |
| Plan rebuild / replan                  | `superfield plan`                                                                       |
| Plan issue (GitHub)                    | Plan issue (GitHub, same format)                                                        |

## Libraries

| Concern                   | Library                                                        |
| ------------------------- | -------------------------------------------------------------- |
| GitHub API                | `@octokit/rest` — typed REST client, first-class TS support    |
| Git operations            | `isomorphic-git` — pure JS/TS git, no binary dependency        |
| HTTP interception (tests) | `msw` — intercepts at the `fetch` level, covers both libraries |

**No system binaries.** Never shell out to `git`, `gh`, `curl`, or any other system executable. All git operations go through a TypeScript git library; all GitHub operations go through a TypeScript GitHub API client. The sole exception is agent vendor CLIs (e.g. `claude`, `codex`) — these are spawned as subprocesses because they are the LLM execution layer, not system utilities.

## Superfield Blueprint

The Superfield Blueprint is a compiled knowledge graph of design rules — architectural constraints, security principles, design patterns, checklists, and antipatterns — sourced from `dot-matrix-labs/calypso-blueprint` and tracked as a git subtree at `blueprint/`. The compiled graph lives at `blueprint/rules/graph.yaml` (1 231 nodes across ARCH, AUTH, DATA, TEST, DEPLOY, ENV, PROCESS, UX, WORKER), with domain bodies under `blueprint/rules/blueprints/*.yaml` and TypeScript-specific implementation rules under `blueprint/rules/implementations/ts/`.

**Current integration state:**

- **Loaded at runtime from disk.** `packages/core/blueprint.ts` parses `graph.yaml` + domain files on demand. The loader resolves `blueprint/` relative to `process.cwd()`. The graph is **not bundled into the compiled `superfield` binary** — the executable only works when a `blueprint/` directory exists alongside the working directory.
- **No in-memory cache.** Every planning-loop tick re-parses the graph from disk (~222 KB YAML).
- **Advisory only, issue-level.** The planning loop's `runBlueprintConformance` (`packages/core/steps/blueprint-conformance.ts`) evaluates open issues against candidate domains and posts `<!-- superfield-blueprint -->`-marked comments citing violated rule IDs. It does **not** block issues from being worked, gate PRs, or fail CI.
- **Not consulted during code generation.** Dev-loop agents (primary / speculative / scout) receive a short prompt fragment (`packages/core/prompts/fragments/blueprint-reference.ts`) that _advises_ them to consult the blueprint, but no actual rule content is injected into prompts and no validation step checks generated code against the graph.
- **Tested with fakeSpawn only.** `blueprint.test.ts` covers the loader; `blueprint-conformance.test.ts` uses hand-crafted `fakeSpawn()` responses. There are no recorded Claude fixtures under `tests/fixtures/claude/blueprint-*` and no `replaySpawn()` coverage.

Each node in the graph carries:

| Field         | Values                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| `number`      | Unique rule ID, e.g. `ARCH-P-001`                                                   |
| `type`        | `threat`, `principle`, `design_pattern`, `architecture`, `checklist`, `antipattern` |
| `description` | Prose statement of the rule                                                         |
| `links`       | Typed edges to related nodes (`depends_on`, `mitigates`, `implements`, etc.)        |
| `deprecated`  | Whether the rule is still active                                                    |

## GitHub Authentication

Superfield uses a GitHub App for user authorization, not manual PAT entry, as the default onboarding path.

Why:

- The CLI needs a smooth sign-in flow that does not require users to generate and paste a PAT.
- GitHub App authorization gives us explicit, repo-scoped permissions that fit the control-plane model.
- The app can authenticate on behalf of a user after they authorize it, while still keeping access narrowly scoped.

Superfield is designed to run on remote VM instances, not developer machines. There is no local browser; the user must visit URLs on their own machine. This rules out OAuth callback flows that require a local HTTP server to receive redirects. GitHub's device flow is the correct primitive — the user enters a code on github.com from any browser, the CLI polls for the token.

GitHub's device flow and GitHub App installation are separate steps with no native API to combine them. The CLI sequences them as a guided flow:

1. **Device flow** — CLI prints a URL and a short code. User opens the URL on their own browser and enters the code. CLI polls until the token arrives.
2. **App installation** — CLI checks if the app is already installed (`GET /user/installations`).
   - If not installed: prints `https://github.com/apps/{slug}/installations/select_target` (forces the account/org picker) and polls every 3 seconds until any installation appears.
   - If installed but the target repo is not in the accessible repo list: prints the same `select_target` URL and polls until any new repo appears in the accessible list (not necessarily the exact target — the user may have run the command from a different directory).
   - If installed and the target repo is accessible (or the installation covers all repos): skips this step.
3. **Repo registration** — CLI resolves the git remote of the current directory, registers `owner/repo` in local config assigned to the authenticated user.

Subsequent runs of `superfield github add` skip any step that is already satisfied (valid token, app already installed, repo already registered).

There is no API to uninstall a GitHub App using a user-to-server token — it requires either a browser visit or the app's RSA private key (which is never embedded in the CLI binary). `superfield github forget` clears local credentials and prints a browser URL for the user to complete the uninstall. The URL is account-type-aware: `https://github.com/organizations/{org}/settings/installations/{id}` for org installations, `https://github.com/settings/installations/{id}` for personal accounts. If the installation ID cannot be fetched, it falls back to `https://github.com/settings/installations`.

The app itself is part of the product infrastructure and must be created and configured before the CLI onboarding flow can be considered complete.

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

**The scout gates the entire phase.** No non-scout issue in a phase may begin until the scout PR is merged. This is enforced by explicit dependencies in the Plan, not by convention.

**Scout merge qualification.** A scout PR qualifies for merge when:

1. TypeScript compiles with zero errors across the entire monorepo
2. All pre-existing tests pass (CI green on the existing suite)
3. New integration test stubs are committed using `it.todo()` / `describe.todo()` — declared but not implemented; CI passes because todo tests do not fail
4. Every planned public interface, type, and no-op stub is present in the code
5. A comment is posted on each downstream feature issue listing the specific stubs and seams it will consume
6. The scout issue checklist is fully checked off

Feature agents convert each `it.todo()` to a real failing test, then implement until it passes.

### Dependencies

Dependencies live in the Plan JSON, not in issue bodies. Each issue in the Plan carries:

```typescript
interface PlanIssue {
  number: number;
  title: string;
  phase: string;
  kind: "dev-scout" | "feature" | "ci-failure"; // drives dev-loop behaviour; stored in Plan metadata
  risk: number; // 1–6
  dependencies: number[]; // issue numbers that must be CLOSED first
  dependents: number[];
  parallel_safe: boolean; // true if all dependencies are CLOSED
}
```

`kind` lives only in the Plan metadata comment, not on the issue body itself — the issue body uses a single unified schema (see Issue Schema).

Validation rules (enforced at plan-write time, not runtime):

- All dependency references exist in the ordered issue list
- All dependencies appear strictly earlier in the list than the issue depending on them
- Every non-scout issue in a phase depends on its phase's scout
- Phase-level dependency edges are acyclic

### Parallelization and merging

Development runs in parallel within a phase; merging is strictly sequential.

**Slots:**

- **Slot 1 — primary**: always the highest-priority unmerged Plan issue. The primary agent drives develop → checklist complete → PR open → CI pass → merge without stopping. It does not exit until the PR is merged and the issue is CLOSED.
- **Slots 2..N — speculative**: feature issues within the current phase whose phase scout is already CLOSED on `main`. Speculative agents drive implementation and checklist to completion then exit without opening a PR. They do not run CI and do not merge.

**Scout gate**: speculative slots remain empty until the phase's dev-scout issue is merged. The scout defines all development seams (outside-in stubs and interfaces) that the parallel feature agents build against. No speculative work begins before those seams exist on `main`.

**Sequential merge invariant**: a PR may only merge when all preceding Plan issues are CLOSED. After each merge the queue advances and any newly unblocked work becomes eligible.

Default: 1 primary + N-1 speculative. N defaults to 3.

---

## Command: `start` internals

The continuous development loop. Runs indefinitely until killed (Ctrl-C).

`start` has three concurrent loops:

### Planning loop — repository health (every 5 seconds)

1. **CI watchdog** — query Check Runs for the latest commit on `main`. On any failed check, create a `ci-failure` issue and insert it at the top of the Plan (deduplicated by SHA + check name). A broken `main` always takes priority over new feature work.
2. **Issue audit** — scan all open issues for schema conformance (required sections present, correct labels). Flag non-conforming issues with a label and a comment describing what is missing.
3. **Plan coverage** — verify every open issue is referenced in the Plan. Append any missing issue in dependency order.
4. **Blueprint conformance** — evaluate open issues and any proposed designs (issue body, acceptance criteria, technical approach) against the active rules in the bundled Superfield Blueprint. For each violation found, post a comment on the issue citing the rule ID, its description, and what in the issue conflicts with it. Does not block the issue from being worked — it informs the agent picking it up.

The planning loop feeds the Plan. It does not perform development work.

### Dev loop — development (Plan-driven)

#### Issue lifecycle

Each Plan issue moves through these stages in order:

1. **Branch** — dedicated worktree checked out from `main`
2. **Develop** — agent works TDD outside-in; commits and pushes to the remote branch frequently for durability (no PR opened — no CI minutes consumed)
3. **Checklist complete** — all feature deliverables and test plan items on the issue are checked off; because agents work TDD throughout, tests pass locally before this point
4. **PR open** — PR opened immediately as ready for review (never draft); CI runs
5. **CI pass** — all check runs succeed
6. **Merge gate** — all preceding Plan issues are CLOSED
7. **Merge** — merged to `main`; issue closed

#### Primary vs speculative agents

- **Primary (slot 1)** — drives the highest-priority issue through all seven stages. Does not exit until the issue is CLOSED.
- **Speculative (slots 2..N)** — drives feature issues through stages 1–3 only, but only if the phase's dev-scout is already merged on `main`. Pushes frequently; does not open a PR. Exits once the checklist is complete.

When an issue that was completed speculatively later becomes the primary, the primary agent picks up at stage 4 (PR open) rather than re-doing the development work.

#### Parallel Claude processes — practical limit

Each slot spawns one agent subprocess. With the default `slotCount: 3` (1 primary + 2 speculative), up to **3 agent processes** run in parallel per configured repository.

**Why this matters:**

- **API rate limits** — Each subprocess counts against your Anthropic API usage. At `slotCount: 3` across several repos you can saturate the API concurrent-request limit quickly.
- **CPU and memory** — Each process loads Node (or Bun), Claude Code, and a git worktree. At 3 slots, RSS can exceed 2 GB on a developer laptop.
- **Context overlap** — Speculative agents share no context with the primary. Merge conflicts become more likely the more agents write in parallel.

**Recommendations:**

| Scenario                           | Suggested `slotCount`               |
| ---------------------------------- | ----------------------------------- |
| Single repo, developer laptop      | 2 (primary only, 1 speculative)     |
| Single repo, CI machine (8+ cores) | 3 (default)                         |
| Multi-repo, any machine            | 2 per repo; cap total at 4-6 agents |
| Rate-limit sensitive accounts      | 1 (primary only)                    |

**How to configure:**

Pass `slotCount` when calling `runDevLoop` or `tickDevLoop`:

```typescript
runDevLoop({ client, owner, repo, token, slotCount: 1 });
```

There is no CLI flag yet. `slotCount` can be set directly when calling `runDevLoop` or `tickDevLoop`, and the CLI `superfield start` command also reads `SUPERFIELD_SLOT_COUNT` from the environment. Invalid values are ignored with a warning and the default slot count is used instead.

#### Loop steps

1. **Select** — identify the primary issue and up to N-1 speculative issues.
   - Primary is always the top of the Plan. `ci-failure` issues sit above all feature work so a broken `main` is remediated first. If no primary: all work is done — stop.
   - Speculative candidates are feature issues in the current phase whose phase scout is CLOSED on `main`. If the scout is not yet merged, speculative slots stay empty — the primary works alone until the scout is through.
2. **Prep** — for each selected issue without an existing worktree, create one via `isomorphic-git` (no `git` binary).
3. **Launch** — dispatch agents in parallel. Primary drives through merge and then exits; speculative agents drive through checklist completion then exit.
4. Loop back to step 1 after the primary exits.

The planning loop and dev loop run concurrently within the same process. The planning loop feeds the Plan; the dev loop drains it.

### Documentation loop — documentation fractal (on every merge to `main`)

The documentation loop runs concurrently with the other two loops. It is triggered whenever a PR merges to `main` and is responsible for keeping all documentation consistent and complete at every level of the fractal.

#### Documentation fractal

Documentation is maintained at three levels, each reflecting the others:

| Level     | Artifacts                                      |
| --------- | ---------------------------------------------- |
| Canonical | PRD, architecture docs, top-level README       |
| Module    | Package READMEs, public API doc comments       |
| Inline    | Function and type doc comments in source files |

A change at any level can create inconsistencies at the others. The loop detects and resolves those inconsistencies.

#### What the loop does on each trigger

1. **Coverage scan** — inspect source files changed in the merged PR. Flag any exported function, class, or type that lacks a doc comment.
2. **Canonical sync** — if the merged PR introduced a significant feature (new command, new public API surface, changed behavior), update the relevant canonical documents (PRD, README) to reflect the current state of the code.
3. **Consistency check** — verify that descriptions in canonical docs, module docs, and inline comments do not contradict each other. Resolve any conflicts by treating the code as ground truth and updating the docs.
4. **PR open** — if any documentation changes are needed, open a single doc PR per trigger. These PRs are merged outside the development loop.

#### CI gating

CI jobs are gated on changes to source code and config files. Documentation-only PRs (changes to `*.md` files and doc comments) do not trigger CI runs and do not consume CI minutes. This means doc PRs can be reviewed and merged freely without competing for CI capacity with development PRs.

---

## Command: `plan` internals

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
  <!-- superfield: {"number":196,"phase":"Identity foundation","kind":"dev-scout","dependencies":[],"parallel_safe":true} -->
- #201 — feat: build user authentication [risk: 4]
  <!-- superfield: {"number":201,"phase":"Identity foundation","kind":"feature","dependencies":[196],"parallel_safe":false} -->
```

Rules: strict total order, no checkboxes, no step numbers, no parallel group annotations. Dependency data lives in the inline `<!-- superfield: ... -->` metadata comments, not in issue bodies.

`plan` is safe to run while `start` is active — it only writes to the Plan issue, which `start` re-reads on the next dev loop cycle.

---

## Command: `feature` internals

Tickets a new feature issue and registers it in the Plan.

1. Prompt the user for a feature description (stdin or argument).
2. Load current Plan and open issues as context.
3. Run the feature-evaluate skill (LLM call): assess PRD fit, detect duplicates, determine phase and dependencies, emit a typed `IssueBody` object.
4. Render the issue body from the typed object.
5. Create the GitHub issue.
6. Append the new issue to the Plan in the correct phase position.

`feature` is safe to run while `start` is active — it writes a new issue and appends to the Plan; `start` will pick it up on the next dev loop cycle.

---

## Issue Schema

All issues created by Superfield are constructed from typed objects, never raw template strings. The schema follows the section names prescribed by the Superfield Blueprint (see `blueprint/rules/blueprints/process.yaml`): **Motivation, Features, Test Plan, Stage**.

There is one unified `IssueBody` type for all issues — feature, scout, and ci-failure issues all share the same shape. Their classification lives on the issue's labels (and in the `PlanIssue.kind` Plan metadata), not in the body. "Feature" and "issue" are interchangeable terms.

```typescript
interface IssueBody {
  title: string;
  phase: string; // which phase this issue belongs to
  motivation: string; // why this work exists
  features: string[]; // checklist items — what must be built/changed
  test_plan: string[]; // checklist items — how it will be verified
  canonical_docs: string[]; // links to relevant blueprint rules, PRD sections, prior art
}
```

Rendered issue body:

```markdown
## Phase

<phase>

## Motivation

<motivation>

## Canonical docs

- <url>

## Features

- [ ] ...

## Test Plan

- [ ] ...
```

---

## Prompt Templates

Every LLM interaction in Superfield runs through a typed prompt builder, never a free-form string assembled at the call site. Prompts live in source code at `packages/core/prompts/`, are unit-tested like any other module, and ship inside the `superfield` executable. There are no external markdown skill files at runtime — the calypso-agents `SKILL.md` files are reference material, not loaded artifacts.

### Why prompts as code

- **Type safety.** Each prompt builder takes a typed context object. The compiler catches missing fields, wrong types, and dead code paths before they reach the LLM.
- **Composability.** Shared fragments (project context, commit standards, role behavior, stop conditions) are reused across tasks instead of copy-pasted into separate skill files.
- **Testability.** Prompt builders are pure functions and can be snapshot-tested. Drift between prompt versions shows up in PR review as a diff, not as a behavior change in production.
- **Evolution.** Adding a new role, a new workflow stage, or a new constraint means editing one fragment, not 14 skill files.

### Structure

```
packages/core/prompts/
  fragments/                   # shared reusable text blocks
    project-context.ts         # what Superfield is, where the PRD lives
    commit-standards.ts        # conventional commits, no `git add .`, no --no-verify
    worktree-isolation.ts      # work only inside your assigned worktree
    role.ts                    # primary vs speculative behavior
    stop-conditions.ts         # when each role exits
    tdd-outside-in.ts          # TDD workflow rules
    blueprint-reference.ts     # how to consult the bundled blueprint
  develop-issue.ts             # primary/speculative dev agent prompt
  dev-scout.ts                 # scout agent prompt (stubs only, it.todo)
  ci-failure.ts                # CI remediation agent prompt
  feature-evaluate.ts          # `feature` command LLM call (emits IssueBody JSON)
  replan-evaluate.ts           # `plan` command LLM call (emits Plan JSON)
  issue-audit.ts               # planning loop step 2 (schema conformance)
  blueprint-conformance.ts     # planning loop step 4 (advisory rule check)
  doc-coverage.ts              # doc loop step 1 (coverage scan)
  doc-canonical-sync.ts        # doc loop step 2 (canonical doc update)
  doc-consistency.ts           # doc loop step 3 (cross-level consistency)
  index.ts                     # public exports
```

### Prompt builder contract

Every prompt builder is a function with this shape:

```typescript
export interface XxxContext {
  /* typed inputs */
}
export function buildXxxPrompt(ctx: XxxContext): string;
```

The returned string is the complete prompt passed to the agent CLI via `spawnAgent`. Builders combine fragments using a small set of helpers (`joinSections`, `bullet`, etc.) — there is no template engine, no string interpolation library, just typed functions returning strings.

### Mapping to workflow

| Trigger                     | Prompt builder                                           | Loop       |
| --------------------------- | -------------------------------------------------------- | ---------- |
| Issue audit (schema check)  | `buildIssueAuditPrompt`                                  | Planning   |
| Blueprint conformance check | `buildBlueprintConformancePrompt`                        | Planning   |
| Dev-scout claimed           | `buildDevScoutPrompt`                                    | Dev        |
| Feature issue claimed       | `buildDevelopIssuePrompt` (role: primary or speculative) | Dev        |
| `ci-failure` issue claimed  | `buildCIFailurePrompt`                                   | Dev        |
| Doc coverage scan           | `buildDocCoveragePrompt`                                 | Doc        |
| Canonical doc sync          | `buildDocCanonicalSyncPrompt`                            | Doc        |
| Doc consistency check       | `buildDocConsistencyPrompt`                              | Doc        |
| `feature` command           | `buildFeatureEvaluatePrompt`                             | (one-shot) |
| `plan` command              | `buildReplanEvaluatePrompt`                              | (one-shot) |

The orchestrator never assembles prompt strings inline — it always calls a typed builder.

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
  <!-- superfield: {"number":<n>,"phase":"...","kind":"dev-scout","dependencies":[],"parallel_safe":true} -->
- #<n> — <title> [risk: <1-6>]
  <!-- superfield: {"number":<n>,"phase":"...","kind":"feature","dependencies":[...],"parallel_safe":false} -->
```

A `ci-failure` entry looks like:

```markdown
- #<n> — fix(repo): <check-name> failed on main @ <sha> [risk: 6]
  <!-- superfield: {"number":<n>,"phase":"watchdog","kind":"ci-failure","dependencies":[],"parallel_safe":true} -->
```

Rules:

- Strict total order — no checkboxes, no step numbers, no parallel group annotations
- `ci-failure` entries appear at the top, above all phase blocks
- Scout always first within its phase
- All issues in a prerequisite phase appear before all issues in the dependent phase
- Dependency data lives in inline `<!-- superfield: ... -->` metadata comments, not in issue bodies
- `start` reads the metadata comments to drive the dev loop; the human-readable lines are for humans

---

## Configuration

Stored as plaintext YAML at `~/.superfield/config.yaml`.

```yaml
users:
  - handle: octocat
    token: ghu_xxxxxxxxxxxx

repositories:
  - owner: my-org
    repo: my-repo
    assignedUser: octocat
```

Multiple users and repositories are supported. Each repository is assigned to one user; that user's token is used for all API calls against that repository.

### Agent session storage

Active agent sessions are stored in the forge as hidden comments on the issue being worked, not on local disk. When an agent claims an issue it posts:

```
<!-- superfield-session:
{"sessionId":"01JNXXX...","role":"primary","slot":1,"startedAt":"2026-04-08T01:00:00Z"}
-->
```

This comment is updated on each resumption and deleted when the issue closes. On startup, Superfield scans open issues for this comment to detect and resume in-progress sessions — the deadman switch. A stale session comment (agent gone, issue still open) is detected by comparing `startedAt` against a configurable timeout; the orchestrator re-claims and resumes.
