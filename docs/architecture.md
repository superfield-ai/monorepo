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

## Superfield Mapping

Superfield is a direct replacement for the superfield-agents + shell script stack:

| superfield-agents concept                 | Superfield equivalent                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Markdown skill (`SKILL.md`)               | TypeScript skill module with typed I/O                                                  |
| Shell script (`.agents/scripts/`)         | TypeScript function; agent vendor CLIs (e.g. `claude`, `codex`) spawned as subprocesses |
| `superfield-auto` orchestrator loop       | `superfield start`                                                                      |
| `superfield-feature` + `feature-evaluate` | `superfield feature`                                                                    |
| Plan rebuild / replan                     | `superfield plan`                                                                       |
| Plan issue (GitHub)                       | Plan issue (GitHub, same format)                                                        |

## Libraries

| Concern                   | Library                                                        |
| ------------------------- | -------------------------------------------------------------- |
| GitHub API                | `@octokit/rest` — typed REST client, first-class TS support    |
| Git operations            | `isomorphic-git` — pure JS/TS git, no binary dependency        |
| HTTP interception (tests) | `msw` — intercepts at the `fetch` level, covers both libraries |

**No system binaries.** Never shell out to `git`, `gh`, `curl`, or any other system executable. All git operations go through a TypeScript git library; all GitHub operations go through a TypeScript GitHub API client. The sole exception is agent vendor CLIs (e.g. `claude`, `codex`) — these are spawned as subprocesses because they are the LLM execution layer, not system utilities.

## Superfield Blueprint

The Superfield Blueprint is Superfield's fine-tuned dev agent model: an opinionated model trained on architectural constraints, security principles, design patterns, checklists, and antipatterns that encodes how to build software correctly. The rules are not a runtime config — they are baked into the model's weights.

**Current implementation (interim).** The fine-tuned model is the target. Today the Blueprint is approximated as a compiled YAML rule graph sourced from `dot-matrix-labs/superfield-blueprint` and tracked as a git subtree at `blueprint/`. The compiled graph lives at `blueprint/rules/graph.yaml` (1 231 nodes across ARCH, AUTH, DATA, TEST, DEPLOY, ENV, PROCESS, UX, WORKER), with domain bodies under `blueprint/rules/blueprints/*.yaml` and TypeScript-specific implementation rules under `blueprint/rules/implementations/ts/`.

**Current integration state:**

- **Loaded at runtime from disk.** `packages/core/blueprint.ts` parses `graph.yaml` + domain files on demand. The loader resolves `blueprint/` relative to `process.cwd()`. The graph is **not bundled into the compiled `superfield` binary** — the executable only works when a `blueprint/` directory exists alongside the working directory.
- **Loaded once per process (singleton cache).** `loadBlueprint` / `loadBlueprintSync` parse the graph once and cache the result in a module-level singleton; subsequent calls return the cached blueprint. `resetBlueprintCache()` is exposed for tests that need a fresh load. There is no re-parsing on each planning-loop tick.
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

## Nexum — Company Knowledge Graph

[`superfield-ai/nexum`](https://github.com/superfield-ai/nexum) is the unified operational store for all company knowledge: product vision, requirements, source code, issues, behavioral traces, errors, and the causal links among them — under one schema and one clock. Agents are first-class writers: they record observations, candidate corrections, and outcomes directly into the graph. It is not a log or a warehouse — it is the shared ground truth that every agent, human, and service reasons against without crossing a system boundary.

Nexum is distinct from the Blueprint: where the Blueprint defines the rules agents follow (encoded in the fine-tuned model), Nexum is the live company brain they reason against. The Blueprint tells an agent _how_ to build; Nexum tells it _what_ to build and _what is currently true_.

**Current state:** Nexum integration is Phase 2 / experimental-flagged. The Phase 1 substitute is the GitOps control plane (GitHub issues, PRs, and comments as the shared state store).

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

## Local Issue Store

Superfield keeps feature issue state in an embedded local database first. The
initial implementation uses `lowdb` with a JSON file adapter because it is
small, typed, and easy for the Studio UI to read from directly. GitHub issues
are materialized from these records and then synced outward.

Local issue records include:

```typescript
interface LocalIssueRecord {
  repo: string;
  number: number;
  title: string;
  body: string;
  status: "draft" | "open" | "in_progress" | "blocked" | "done";
  acceptance: { title: string; done: boolean }[];
  testPlan: { title: string; done: boolean }[];
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  prNumber?: number;
  prUrl?: string;
  syncedAt?: string;
  updatedAt: string;
}
```

The Studio UI reads from this store for issue lists, checklists, and progress
state. GitHub remains the outward-facing projection used for review and merge
tracking.

---

## Command: `start` internals

The continuous development loop. Runs indefinitely until killed (Ctrl-C).

`start` has three concurrent loops:

### Planning loop — repository health (every 5 seconds)

1. **CI watchdog** — query Check Runs for the latest commit on `main`. On any failed check, create a `ci-failure` issue and insert it at the top of the Plan (deduplicated by SHA + check name). A broken `main` always takes priority over new feature work.
2. **Issue audit** — scan all open issues for schema conformance (required sections present, correct labels). Issues are processed in batches of 25, with up to 3 concurrent batch LLM calls. Each call returns an `{ reports: IssueAuditReport[] }` array covering all issues in the batch. Non-conformant issues have their bodies rewritten in-place and are labelled `non-conformant`; conformant issues have stale labels removed. An incremental cache (stored as a hidden comment on the Plan issue) skips issues whose body+labels fingerprint has not changed since the last audit pass (min re-audit interval: 10 minutes). Result shape: `{ audited, nonConformant: number[], reports: Record<number, IssueAuditReport> }`.
3. **Plan coverage** — verify every open issue is referenced in the Plan. Issues whose body declares `## Phase` are placed deterministically. Issues without a phase declaration are sent in a single LLM batch call (`buildPlanPlacementPrompt`, Haiku) which assigns each issue to an existing phase or creates a new one. LLM-placed issues that land in a phase with no scout gate are deferred (`skipped`) until a scout is present. Result shape: `{ appended, alreadyCovered, skipped, llmPlaced, createdPhases, planCreated }`.
4. **Blueprint conformance** — evaluate open issues against candidate domains from the Superfield Blueprint and post `<!-- superfield-blueprint -->`-marked advisory comments on violations. Runs against the issue snapshot fetched at the start of the tick (before audit rewrites). Does not block the issue from being worked — it informs the agent picking it up.

All four steps share the same `allOpenIssues` snapshot fetched once at the start of step 2. Blueprint conformance therefore sees pre-remediation issue bodies when audit rewrites happen in the same tick; post-remediation bodies are checked on the next tick (when the fingerprint changes and the incremental cache triggers a re-audit).

The planning loop feeds the Plan. It does not perform development work.

### Dev loop — development (Plan-driven)

#### Issue lifecycle

Each Plan issue moves through these stages in order:

1. **Branch** — dedicated worktree checked out from `main`
2. **Develop** — agent works TDD outside-in; commits and pushes to the remote branch frequently for durability (no PR opened — no CI minutes consumed)
3. **Checklist complete** — all feature deliverables and test plan items on the issue are checked off; because agents work TDD throughout, tests pass locally before this point
   3a. **Pre-PR blueprint self-audit (#81)** — the agent reads its own diff against the full blueprint context (implementation rules + principles + threats + antipatterns for the issue's candidate domains) and emits a structured `{ conformant, violations }` verdict. On `conformant: true` the loop proceeds to stage 4. On `conformant: false` the loop persists the violations on the session comment, bumps the remediation counter, and loops back to stage 2 (develop) with the violations injected as explicit fix instructions. Remediation is capped at 3 passes per issue — the fourth non-conformant verdict logs an error and exits the slot without opening a PR (manual intervention required). The counter persists across dev-loop restarts via the session comment.
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
3. Run the feature-evaluate skill (LLM call): assess PRD fit, detect duplicates, determine phase and dependencies, emit a typed local issue object.
4. Persist the local issue object to the embedded issue store.
5. Render the GitHub issue body from the stored object.
6. Create or update the GitHub issue from the local record.
7. Append the new issue to the Plan in the correct phase position.

`feature` is safe to run while `start` is active — it writes a new issue and appends to the Plan; `start` will pick it up on the next dev loop cycle.

---

## Issue Schema

All issues created by Superfield are constructed from typed objects, never raw template strings. The embedded issue store is the source of truth. GitHub issues are generated from these records and keep the section names prescribed by the Superfield Blueprint (see `blueprint/rules/blueprints/process.yaml`): **Motivation, Features, Test Plan, Stage**.

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

Every LLM interaction in Superfield runs through a typed prompt builder, never a free-form string assembled at the call site. Prompts live in source code at `packages/core/prompts/`, are unit-tested like any other module, and ship inside the `superfield` executable. There are no external markdown skill files at runtime — the superfield-agents `SKILL.md` files are reference material, not loaded artifacts.

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

---

## Control Webapp

The `superfield control` subcommand starts a browser UI on `:7000` that drives a single Superfield project. Product scope is in [`product.md` § Control Webapp](./product.md#control-webapp); this section is the implementation contract.

### Process model

```
superfield control  (:7000)
  │
  ├── HTTP server + WebSocket  (browser UI, studio turns)
  │
  ├── DevLoopProcess           (child: superfield start <repo>)
  │     plan / dev / doc loops
  │     API server on :7837
  │           │
  │           └── HTTP (analytics read, steer write) ←── orchestrator view
  │
  └── Routes:
        /                      — ControlPanel (chat + iframe)
        /studio/orchestrator   — OrchestratorView
        /studio/preview        — ComponentPreviewPanel + tokens + mocks
        /studio/deploy         — DeployView (Phase 9)
```

`superfield start` is spawned as a child of `superfield control` when the user clicks Start in the orchestrator. Control holds the `ChildProcess`, monitors it, and terminates it on Stop or shutdown. If a dev loop is already reachable at `--api-url` (default `http://127.0.0.1:7837`), control attaches to it without spawning.

### Shared-state contract

`ApiState` is in-memory in the dev-loop process. With control as a separate process:

- **Reads** — control polls `GET /analytics/*` on `:7837`.
- **Writes** — control proxies steers to `POST /steer/context` and `POST /steer/escalate` on `:7837`. Control never holds steering state.

If the dev loop is not running, control queues steers locally and retries when the API becomes reachable. Steers are not persisted across control restarts — they are a live-session concept. `bun:sqlite` is explicitly banned by `IMPL-DATA-038`; durable steer queues are deferred until they become a real requirement.

### HTTP routes (control server, :7000)

| Method | Path                           | Purpose                                                                 |
| ------ | ------------------------------ | ----------------------------------------------------------------------- |
| GET    | `/studio/ws`                   | WebSocket upgrade for chat turns + steer frames                         |
| POST   | `/studio/steer`                | REST fallback — proxies to `POST <api-url>/steer/context`               |
| POST   | `/studio/rebuild`              | Rebuild + rollout restart                                               |
| GET    | `/studio/chat/stream`          | SSE legacy chat stream (kept for tests; WS is canonical)                |
| GET    | `/studio/cluster/events`       | SSE — aggregate cluster health                                          |
| GET    | `/studio/status`               | Studio mode + auth                                                      |
| GET    | `/studio/commits`              | Session commit log                                                      |
| GET    | `/studio/timeline`             | Checkpoint timeline                                                     |
| POST   | `/studio/rollback`             | Reset HEAD to prior commit                                              |
| POST   | `/studio/reset`                | Clear in-memory session messages                                        |
| POST   | `/studio/chat`                 | Send message, run agent, return reply                                   |
| GET    | `/orchestrator/status`         | `{ process, pid, apiReachable, uptimeMs }`                              |
| POST   | `/orchestrator/start`          | Spawn `superfield start <repo>` — body `{ repo, slotCount }`            |
| POST   | `/orchestrator/stop`           | SIGTERM the managed process; SIGKILL after 5 s                          |
| GET    | `/orchestrator/logs`           | SSE — combined stdout/stderr ring buffer + live tail                    |
| GET    | `/studio/turns/:sessionId`     | Per-session turn timeline (Phase 9 — reads `<CONTROL_LOG_DIR>/*.jsonl`) |
| GET    | `/studio/blueprint/recent`     | Last 50 issues with `<!-- superfield-blueprint -->` comments (Phase 9)  |
| GET    | `/studio/deploy/envs`          | Envs known from forge variables (Phase 9)                               |
| GET    | `/studio/deploy/doctor/:env`   | Calls `runDoctor(env)`; returns checks array (Phase 9)                  |
| GET    | `/studio/deploy/secrets/:env`  | Presence-only audit of three required secrets (Phase 9)                 |
| GET    | `/studio/deploy/ci`            | Latest workflow run on `main` + deploy run (Phase 9)                    |
| POST   | `/studio/deploy/rollback/:env` | Calls `rollbackEnv(env)` with `{ confirm: true }`; SSE log (Phase 9)    |
| GET    | `/app/*`                       | Reverse-proxy to web ClusterIP service (strips `/app`)                  |
| GET    | `/api/*`                       | Reverse-proxy to api ClusterIP service                                  |

Routes under `/studio/*` (except `/studio/chat/stream`, `/studio/cluster/events`) and `/api/auth/*` skip the auth check; everything else requires the studio JWT cookie.

### Modules

| File                                          | Role                                                                |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `packages/control/src/index.ts`               | `startControl(opts?)` — server entry                                |
| `packages/control/src/router.ts`              | HTTP route dispatch                                                 |
| `packages/control/src/control-ws.ts`          | Bun WebSocket handler (chat turns, steers)                          |
| `packages/control/src/agent.ts`               | `runAgent()` — calls `POST <api-url>/studio/run`                    |
| `packages/control/src/claude-session.ts`      | `streamTurn()` — pipes SSE from `/studio/run` to the browser        |
| `packages/control/src/orchestrator.ts`        | `/orchestrator/*` endpoints                                         |
| `packages/control/src/dev-loop-process.ts`    | Child process lifecycle for `superfield start`                      |
| `packages/control/src/cluster-status-sse.ts`  | `/studio/cluster/events` aggregator                                 |
| `packages/control/src/hot-swap.ts`            | Component hot-reload                                                |
| `packages/control/src/design-mode-context.ts` | Studio-mode feature flag                                            |
| `packages/control/apps/src/components/`       | React UI (ControlPanel, OrchestratorView, ComponentPreviewPanel, …) |
| `packages/control/apps/src/controllers/`      | Browser-side controllers (Chat, ClusterStatus, Orchestrator, …)     |

### Superfield core extension

`POST /studio/run` lives on the dev-loop API server (`packages/core/api-server.ts`).

```
POST /studio/run

Request body:
  message       string   — the user turn
  repoRoot      string   — absolute path the agent works in
  sessionKey    string?  — resume an existing session (optional)
  allowedTools  string   — comma-separated tool list
  mode          string   — 'design' | 'question'

Response: SSE
  event: session   data: { sessionId }        — once, before first chunk
  (default)        data: <stdout chunk>        — one per chunk
  event: done      data: { filesChanged: [] } — turn complete
  event: error     data: <message>            — spawn failure or non-zero exit
```

It spawns `claude` with the same args as `spawnAgentBackend` but streams `stdout` chunk-by-chunk via `res.write()`. The subprocess is registered in `ApiState` slot tracking so analytics, steers, and escalations work the same as for autonomous-loop agents.

### Filesystem isolation

`SUPERFIELD_DEV=1` is set only on the dev loop process.

| Path                           | Dev loop (`SUPERFIELD_DEV=1`)         | Control     |
| ------------------------------ | ------------------------------------- | ----------- |
| `~/.superfield/config.yaml`    | read (GitHub tokens needed for loops) | not read    |
| `~/.superfield/logs/`          | NOT written — uses `mkdtemp` tmpdir   | not written |
| `/tmp/superfield-worktrees/`   | used for issue clones                 | not used    |
| `<repo>/.studio`               | read (sessionId / branch)             | read        |
| `<repo>/docs/studio-sessions/` | not touched                           | written     |

Control's only filesystem writes are JSONL turn logs at `<CONTROL_LOG_DIR>/YYYY-MM-DD.jsonl` (defaults to a tmpdir or `../studio-logs` relative to repo root).

### Running standalone

Control runs without the dev loop — agent turns return `503 Superfield API unavailable`, but status, commits, rollback, chat history, and the design-mode panels work. Useful for UI development.

### Testing

| Layer       | Location                                       | Strategy                                                 |
| ----------- | ---------------------------------------------- | -------------------------------------------------------- |
| Unit        | `cli/packages/control/tests/unit/`             | `agent.ts`, `claude-session.ts` stub `fetch` (not spawn) |
| Integration | `cli/packages/control/tests/integration/`      | `superfield-server.ts` fixture starts API in-process     |
| E2E         | `cli/packages/control/tests/e2e/` (Playwright) | Two k3d images: `superfield-studio` + `superfield-agent` |

The claude stub at `tests/fixtures/claude` lives on the agent image only; the studio image has no claude dependency.

---

### Agent session storage

Active agent sessions are stored in the forge as hidden comments on the issue being worked, not on local disk. When an agent claims an issue it posts:

```
<!-- superfield-session:
{"sessionId":"01JNXXX...","role":"primary","slot":1,"startedAt":"2026-04-08T01:00:00Z"}
-->
```

This comment is updated on each resumption and deleted when the issue closes. On startup, Superfield scans open issues for this comment to detect and resume in-progress sessions — the deadman switch. A stale session comment (agent gone, issue still open) is detected by comparing `startedAt` against a configurable timeout; the orchestrator re-claims and resumes.

---

## Single-Instance Database Schema Layout

**Decision date:** 2026-05-30
**Status:** Accepted

### Decision

All Rust components (Sharp, Nexum, auth, and any future component) share **one Postgres instance** and use **namespaced schemas** within that instance — one PostgreSQL schema per component. There is no second Postgres process and no separate database per component.

Rejected alternatives:

| Option                                                | Why rejected                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One shared `public` schema, all tables flat           | Table name collisions across components (`api_keys` appears in both Sharp and Nexum auth paths); migration ownership is ambiguous; RLS policies cannot be scoped per component without prefix conventions that are error-prone to enforce. |
| Separate Postgres database per component              | Cross-component joins require `dblink` or FDW, adding a network hop and precluding atomic transactions that span component boundaries; eliminates the join advantage of a single instance.                                                 |
| Second Postgres process (Nexum's AGE shim at `:5433`) | Non-conforming with the one-binary one-instance architecture decision. The AGE graph extension must run inside the primary instance as an in-instance extension, not as a separate server.                                                 |

### Schema namespace assignment

Each component owns exactly one PostgreSQL schema. All tables, indexes, sequences, and functions for that component live in its schema. No component may create objects in another component's schema.

| PostgreSQL schema | Owner component | Tables (current)                                                                                                           |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `sharp`           | Sharp           | `repos`, `objects`, `refs`, `commit_paths`, `commit_metadata`, `api_keys`, `projections`                                   |
| `nexum`           | Nexum           | `corpora`, `documents`, `document_versions`, `blocks`, `version_blocks`, `links`, `entities`, `corpus_access`, `job_queue` |
| `auth`            | Auth (shared)   | `sessions`, `oauth_tokens`, `app_installations` (to be defined during auth port)                                           |
| `episodes`        | Orchestrator    | `episodes`, `episode_events`, `episode_outcomes` (to be defined; tracks agent behavioral traces)                           |

**Schema creation is the first step of each component's migration sequence.** Migration runners call `CREATE SCHEMA IF NOT EXISTS <component>` before any `CREATE TABLE`.

### Table naming convention

Within each schema, table names are unqualified (no prefix). The schema name provides the namespace. Cross-component SQL always uses fully qualified `<schema>.<table>` references.

```sql
-- Correct: qualified reference from an orchestrator query
SELECT e.id, b.content
FROM   episodes.episodes   e
JOIN   nexum.blocks        b ON b.id = e.source_block_id;

-- Wrong: bare table name from outside the owning schema
SELECT * FROM blocks;  -- which schema? ambiguous — never do this cross-component
```

### Migration ownership

Each component owns its schema's migrations exclusively. Migration files are colocated with the component's source code:

| Component | Migration path                                                               |
| --------- | ---------------------------------------------------------------------------- |
| Sharp     | `superfield-ai/sharp/apps/server/migrations/`                                |
| Nexum     | `superfield-ai/nexum/db/migrations/`                                         |
| Auth      | `crates/sf-auth/src/migrations/` (Rust crate)                                |
| Episodes  | `superfield-ai/superfield-cli-ts/packages/orchestrator/migrations/` (target) |

The migration runner (tracked separately) applies all pending migrations from all components in dependency order at startup. Component migrations must be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`).

### Cross-component joins and RLS scoping

**Joins are cheap because all schemas live in the same instance.** A query can join `sharp.objects` to `nexum.blocks` to `episodes.episode_events` in a single statement with no network round-trip. This is the primary motivation for the single-instance architecture.

**RLS policies are scoped per schema.** When row-level security is introduced (not yet implemented — see §Current Gaps), each component's `ENABLE ROW LEVEL SECURITY` and policies apply to its own schema tables only. The `auth.sessions` table provides the identity context that all schemas' policies will reference via `current_setting('app.current_principal_id')`.

#### Sample cross-component query

The query below finds all Sharp commits that reference Nexum document blocks (cross-component semantic traceability — illustrates the join model under the namespaced layout):

```sql
-- Find Sharp commits touching files whose content is semantically linked to
-- a given Nexum document block, joining across the sharp and nexum schemas.
--
-- This runs inside a single Postgres session with no FDW or dblink.
-- Both schemas live in the same database on the same instance.

SELECT
    r.name                                          AS repo_name,
    encode(cp.commit_id, 'hex')                     AS commit_sha,
    cp.path                                         AS file_path,
    b.content                                       AS linked_block_content,
    l.rel_type                                      AS link_type
FROM   sharp.commit_paths     cp
JOIN   sharp.repos             r  ON r.id = cp.repo_id
-- Match file path to a Nexum block's source_path via its parent document
JOIN   nexum.documents         d  ON d.source_path = cp.path
JOIN   nexum.document_versions dv ON dv.doc_id = d.id
JOIN   nexum.version_blocks    vb ON vb.version_id = dv.id
JOIN   nexum.blocks            b  ON b.id = vb.block_id
-- Traverse Nexum semantic links originating from those blocks
JOIN   nexum.links             l  ON l.src = b.id
WHERE  l.layer    = 'semantic'
  AND  l.confirmed IS NOT FALSE   -- include unreviewed and accepted links
ORDER  BY r.name, commit_sha, cp.path;
```

This query compiles and executes correctly under the namespaced schema layout. It would require `dblink` or FDW if the components lived in separate Postgres databases.

### AGE graph extension

The Apache AGE graph shim (`nexum/db/migrations/0001_age_shim.sql`) that previously required a second Postgres process on `:5433` has been removed. Graph traversal now runs on the primary Postgres instance using recursive CTEs over the `nexum.links` table.

**Decision:** Recursive CTEs over `nexum.links` rather than AGE-in-instance.

Apache AGE requires a patched Postgres build; the standard `postgres:16` image used throughout this stack does not ship it. Recursive CTEs over `nexum.links` deliver equivalent multi-hop traversal on any stock Postgres 14+ instance with no patched binary, no compose service, and no second port. AGE-in-instance remains the long-term option if Cypher query volume demands it, but recursive CTEs satisfy current parity and close the architectural gap.

The `packages/db/nexum-graph.ts` module provides `traverseGraph()` (recursive CTE), `isGraphReady()`, and `NEXUM_GRAPH_SETUP_SQL`. Integration tests in `packages/db/tests/nexum-graph.test.ts` verify multi-hop traversal against a single containerised Postgres instance.

---

## Governed Embedding Standard

**Decision date:** 2026-05-31
**Status:** Accepted — closes #360

### Standard

| Property       | Value                                                    |
| -------------- | -------------------------------------------------------- |
| **Model**      | `Xenova/all-MiniLM-L6-v2`                                |
| **Dimensions** | 384                                                      |
| **Runtime**    | Local inference via Xenova (ONNX) — no external API call |
| **Distance**   | Cosine similarity                                        |
| **Index type** | HNSW (cosine) via pgvector                               |

All vector columns across every store **must** use 384-dimensional vectors produced by this model. No other embedding model or dimensionality is permitted without a superseding architecture decision.

### Rationale

- Nexum has shipped `blocks.embedding vector(384)` with `Xenova/all-MiniLM-L6-v2` as its production embedding layer. Standardising on the existing implementation avoids a re-embedding migration.
- Local ONNX inference (Xenova) keeps all vector production inside the one-binary boundary. No external API key, no network call, no vendor dependency at inference time.
- 384 dimensions provide adequate semantic resolution for document-block retrieval while keeping index size and query latency low.
- A single vector space means a Sharp episode can join semantically to a Nexum block in one SQL query, without coordinate-system translation.

Rejected alternatives:

| Option                                     | Why rejected                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI `text-embedding-3-small` (1536-dim) | External API dependency; breaks the one-binary constraint; costs per embedding; dimension mismatch with existing Nexum data requiring a full re-embed. |
| OpenAI `text-embedding-ada-002` (1536-dim) | Same objections as above.                                                                                                                              |
| A larger local model (768+ dim)            | Re-embedding all existing Nexum corpora; larger index; no demonstrated retrieval gain for code/document block workloads.                               |

### Vector column inventory

Every vector column across all stores must match the governed standard. Current inventory:

| Component | Schema  | Table    | Column           | Declared dimension | Status                                           |
| --------- | ------- | -------- | ---------------- | ------------------ | ------------------------------------------------ |
| Nexum     | `nexum` | `blocks` | `embedding`      | 384                | Conforming — HNSW cosine index live              |
| Nexum     | `nexum` | `links`  | `edge_embedding` | 384                | Conforming — stub, populated Phase 2 (issue #75) |
| Sharp     | `sharp` | —        | —                | —                  | No vector columns yet; pgvector not installed    |
| CLI       | local   | —        | —                | —                  | No vector columns; lowdb JSON store              |

When Sharp or any future component adds a vector column it **must** declare `vector(384)` and reference this section.

### Adoption rule for new stores

Any migration that introduces a vector column must:

1. Declare the column as `vector(384)`.
2. Add an HNSW cosine index: `CREATE INDEX … USING hnsw (col vector_cosine_ops)`.
3. Reference the governed model in a migration comment: `-- embedding model: Xenova/all-MiniLM-L6-v2, 384-dim`.

---

## Sharp — Tier-1 Rust Semantic Merge

Sharp performs semantic merge for Rust source files using **rust-analyzer** as a subprocess (analogous to how `tsserver` is orchestrated for TypeScript). This is self-hosting-critical: Sharp must semantically merge its own and the stack's Rust source under the no-non-compiling-merge guarantee.

### Components (`crates/sharp`)

| Module                       | Role                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo` / `object` / `commit` | VCS core — objects, refs, commits, and the DAG on the `sharp` schema                                                                                       |
| `episode`                    | Agent-episode lifecycle — open, append, finish, query                                                                                                      |
| `git_interop`                | Git import (SHA-1 keyed store) and linear-only export                                                                                                      |
| `rust_analyzer_client`       | LSP subprocess orchestrator — spawns `rust-analyzer`, performs the initialize handshake, and exposes `get_rename_locations(file, line, col, include_decl)` |
| `cargo_check`                | Structural verification gate — runs `cargo check --message-format=json` and parses compiler errors                                                         |
| `semantic_merge`             | Tier-1 merge algorithm — rename detection, 3-way textual baseline, cargo check gate                                                                        |
| `error`                      | Shared `SharpError` type                                                                                                                                   |

### Merge algorithm (Tier-1)

1. **Rename detection** — for each file changed on "ours" relative to base, ask rust-analyzer (via `textDocument/references`) for the rename-location set of every symbol whose identifier changed. If the same symbol is renamed on "ours" and edited on "theirs", the rename wins and all reference locations are propagated.
2. **Textual baseline** — apply a 3-way line-level merge. The rename-aware pass resolves rename-vs-edit conflicts before the textual merge runs, so the textual merge is clean for renamed symbols.
3. **Verification gate** — run `cargo check` on the merged workspace. A non-zero exit → `SharpError::MergeRefused` with structured diagnostics. No merge that fails to compile reaches storage.

### rust-analyzer subprocess protocol

rust-analyzer speaks LSP (JSON-RPC 2.0) over stdin/stdout with `Content-Length` framing. The client:

1. Spawns `rust-analyzer` with `stdin/stdout` piped.
2. Sends `initialize` with `rootUri` set to the Cargo workspace root.
3. Waits for the `initialize` response, then sends `initialized`.
4. Sends `textDocument/didOpen` for each file to analyze.
5. Sends `textDocument/references` to enumerate rename locations.
6. Sends `shutdown` + `exit` when done.

The binary is located via `PATH` first, then `rustup which rust-analyzer` as a fallback.

### Self-hosting gate

Sharp manages Superfield's own Rust source (`crates/sharp`) as its primary dogfood repository. Any merge of Sharp's own code passes through the Rust semantic merge path, exercising the no-non-compiling-merge guarantee on production source.

1. **Onboarding** — the `crates/sharp` workspace is registered as a Sharp repo via `repo::init`.
2. **Merge routing** — every merge of Sharp's own Rust source passes through `semantic_merge_rust`, which orchestrates `rust-analyzer` for rename enumeration and `cargo check` for structural verification.
3. **Episode recording** — each merge opens an episode (`episode::open`), appends a `merge_result` event (renames propagated, files merged, compile gate outcome), then finishes the episode.

#### Test coverage

| Test                                               | What it proves                                                                   | Requires                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| `self_hosting_gate_semantic_merge_on_sharp_source` | Rename propagation + 3-way merge resolves rename-vs-edit cleanly on Sharp source | Nothing — pure Rust, runs in CI             |
| `self_hosting_gate_compile_gate_refuses_bad_merge` | Compile gate detects and refuses a non-compiling merge output                    | `cargo` on PATH                             |
| `self_hosting_gate_with_episode`                   | Full end-to-end: VCS store + episode recording + semantic merge                  | `DATABASE_URL`, applied migrations, `cargo` |

---

## §7 Current Gaps

| #   | Gap                                                                      | Target state                                                                                                | Tracking                                                                                                                                             |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Schema-sharing boundary not codified                                     | Namespaced schemas per component as described above                                                         | Closed by #355                                                                                                                                       |
| 2   | AGE shim runs on a second Postgres at `:5433`                            | AGE as in-instance extension on primary Postgres                                                            | Closed by #359 — recursive CTEs on `nexum.links` (see §6)                                                                                            |
| 3   | No RLS policies anywhere                                                 | Per-schema RLS enabled; policies reference `auth.sessions`                                                  | Partially closed by #358 — migration stubs and session context wiring in `packages/db/`; full per-schema policies require component schemas to exist |
| 4   | No cross-component migration runner                                      | Single runner applies all component migrations in dependency order at startup                               | Open — tracked in migration-runner issue                                                                                                             |
| 5   | `episodes` schema not yet defined                                        | Schema and tables defined during orchestrator port                                                          | Open                                                                                                                                                 |
| 6   | `auth` schema not yet defined                                            | Schema and tables defined during auth port                                                                  | Closed by #364                                                                                                                                       |
| 7   | No governed embedding standard across stores                             | Single model and dimensionality declared; all vector columns conforming                                     | Closed by #360                                                                                                                                       |
| 8   | Rust workspace crate boundaries not mapped                               | Runtime/entrypoint inventory, shared-concern map, proposed crate layout                                     | Closed by #387 — see `docs/scout/387-existing-service-runtimes-and-shared-boundaries.md`                                                             |
| 9   | Embedding crate (`sf-embed`) not wired into component crates             | `nexum` and `sharp` depend on `sf-embed` for all vector columns                                             | Closed by #363 (crate exists; consumers pending)                                                                                                     |
| 10  | Sharp TypeScript semantic analysis (tsserver subprocess) not implemented | `packages/sharp` — `TsserverClient` orchestrates `tsserver` for rename enumeration and semantic diagnostics | Closed by #371                                                                                                                                       |
| 11  | Rust semantic merge not implemented                                      | `crates/sharp` Tier-1 merge via rust-analyzer + cargo check gate                                            | Closed by #372                                                                                                                                       |
| 12  | Sharp self-hosting gate not yet live                                     | Sharp manages Superfield Rust source end-to-end in production                                               | Closed by #374                                                                                                                                       |
| 13  | `sf-serve` route surface is partial                                      | Full route parity with TypeScript control server (`/studio/*`, `/orchestrator/*`, chat SSE, rollback, etc.) | Open — tracked in #377 / #378                                                                                                                        |
