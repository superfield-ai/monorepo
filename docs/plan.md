# Implementation Plan

All 10 phases of the PRD roadmap landed. This document is now a snapshot of
what was built; future work should reopen specific items.

## Status legend

- ✅ Done — landed on `main`
- 🟡 Partial — exists but incomplete
- ⬜ Not started

---

## Phase 1 — Foundation ✅

- ✅ Monorepo: `packages/cli`, `packages/core`, `packages/github`, `packages/git`
- ✅ Config read/write at `~/.superfield/config.yaml`
- ✅ `@octokit/rest` client wrapper with MSW test harness
- ✅ `isomorphic-git` wrapper with MSW test harness
- ✅ GitHub Actions CI: build, unit tests, integration tests
- ✅ Golden fixtures recorder (`bun record-fixtures`)
- ✅ `superfield github add` (device flow + app installation polling + repo registration)
- ✅ `superfield github forget` (account-type-aware uninstall URL)
- ✅ `superfield doctor`
- ✅ Calypso Blueprint integrated as git subtree at `blueprint/` with bidirectional sync workflows

## Phase 2 — Planning loop: CI watchdog ✅

- ✅ Detect failed checks on `main` via `getCheckRuns`
- ✅ Create `ci-failure` issue with deduplication by SHA + check name
- ✅ Issue body uses unified `IssueBody` schema (Phase / Motivation / Canonical docs / Features / Test Plan)
- ✅ Insert ci-failure at top of Plan via `Plan` parser/serializer
- ✅ Plan entry format: `- #N — title [risk: 6]\n  <!-- superfield: {...} -->`
- ✅ Renamed `runOuterLoop` → `runPlanningLoop`
- ✅ `packages/core/plan.ts` parser + 17 unit tests

## Phase 3 — Planning loop: issue audit + Plan coverage ✅

- ✅ `runIssueAudit` — LLM-driven schema conformance via `buildIssueAuditPrompt`
- ✅ Posts findings comment with `<!-- superfield-audit -->` dedupe marker
- ✅ Bounded concurrency (default 3 parallel agent invocations)
- ✅ `runPlanCoverage` — pure deterministic, appends missing open issues to Backlog phase
- ✅ Skips plan/ci-failure labelled issues; classifies dev-scout label
- ✅ `runLLMTask` reusable helper with `extractJson` (handles fenced + bare JSON)

## Phase 4 — Planning loop: blueprint conformance ✅

- ✅ `loadBlueprint` — parses `blueprint/rules/graph.yaml` + per-domain yamls
- ✅ Handles graph hash collisions with `uniqueKeys: false`
- ✅ `pickCandidateDomains` — naive keyword heuristic across 13 domains, max 4 candidates
- ✅ `runBlueprintConformance` — LLM-driven advisory check, posts/updates `<!-- superfield-blueprint -->` comments
- ✅ Deletes stale advisory when violations are resolved
- ✅ Skips issues with no candidate domains (no LLM call)

## Phase 5 — Agent infrastructure ✅

- ✅ `spawnAgent` (`packages/core/agent.ts`) — `claude` / `codex` subprocess wrapper
- ✅ Forge-stored sessions (`packages/core/sessions.ts`) — `<!-- superfield-session: -->` comments
- ✅ `findStaleSessions` — deadman switch scan
- ✅ Prompt templating system (`packages/core/prompts/`) — fragments + 10 builders
- ✅ Snapshot tests for all 10 prompt builders
- ✅ MSW-style mock-based tests for forge session CRUD
- ✅ Worktree manager (`packages/git/worktree.ts`) using isomorphic-git
- ✅ `WorktreeManager.create` falls back to base branch if issue branch absent
- ✅ `pruneClosed` cleanup helper

## Phase 6 — `plan` command ✅

- ✅ `runPlanCommand` — collect → evaluate (LLM) → create-scouts → validate → apply
- ✅ `PlanProposal` shape: phases, ordered_issues, scout_specs
- ✅ `patchScoutNumber` — replaces null-numbered scouts with real issue numbers
- ✅ `validateProposal` — duplicate detection, scout-first per phase, exactly one scout, acyclic phase deps (DFS coloring)
- ✅ `validatePlan` — structural validation of the rendered Plan body before write-back
- ✅ `renderIssueBody` — blueprint-aligned IssueBody markdown
- ✅ CLI wired: `superfield plan [path]`

## Phase 7 — Dev loop primary agent ✅

- ✅ `runDevLoop` / `tickDevLoop` — primary-only loop
- ✅ `selectPrimary` — ci-failures first, then phase issues; skips closed and waits for predecessors
- ✅ `runSlot` extracted as per-slot helper
- ✅ Builds prompt by `kind`: dev-scout / develop-issue / ci-failure
- ✅ Claims slot via session comment BEFORE spawning (deadman switch)
- ✅ Resumes existing session when comment present
- ✅ Detects close on post-spawn refetch and clears session

## Phase 8 — Dev loop speculative slots ✅

- ✅ `selectSpeculative` — scout-gated; only opens if phase scout is CLOSED on `main`
- ✅ Configurable `slotCount` (default 3 = 1 primary + 2 speculative)
- ✅ Primary + speculative dispatched in parallel via `Promise.all`
- ✅ Speculative agents do not check issue close (they exit at checklist complete)
- ✅ Never pairs speculative work with a ci-failure primary

## Phase 9 — `feature` command ✅

- ✅ `runFeatureCommand` — collect → evaluate (LLM) → handle duplicate → create issue → append to Plan
- ✅ Returns `duplicateOf` when LLM identifies a duplicate (no issue created)
- ✅ `parseFeatureEvaluation` validates required fields
- ✅ Appends to existing Plan or creates new Plan with phase
- ✅ CLI wired: `superfield feature "<description>" [path]`

## Phase 10 — Documentation loop ✅

- ✅ `runDocLoop` / `tickDocLoop` — third concurrent loop
- ✅ Watermark-based merge detection (in-memory)
- ✅ Three doc tasks parallel: `runCoverageScan`, `runCanonicalSync`, `runConsistencyCheck`
- ✅ `openDocPR` — creates `docs/auto-N` branch, applies patches via Contents API, opens PR
- ✅ Patch validation: only applies if `old_text` matches current file content
- ✅ CI gating: `paths-ignore` on `**/*.md` and `docs/**` in build/test-unit/test-integration workflows
- ✅ New GitHubClient API: `listMergedPullRequests`, `listPullRequestFiles`, `createBranch`,
  `getFileContents`, `putFileContents`, `createPullRequest`

---

## Cross-cutting tech debt

- ✅ Pre-existing TypeScript errors fixed (deleted dead `setup.ts` + narrowed `string[] | "all"` types)
- ✅ Snapshot tests for each prompt builder
- ✅ All tests passing: 183 unit + 3 integration

## Remaining cross-cutting work (not in PRD scope)

- ⬜ Wire all three loops together inside `superfield start` (currently only the planning loop runs;
  the dev loop and doc loop are exported but not launched from `startCommand`)
- ⬜ Integration test that exercises a full planning-loop tick end-to-end against MSW
- ⬜ Integration tests for dev-loop and doc-loop using recorded fixtures

## Out of scope (entire roadmap)

- Slack / webhook notifications
- Web UI
- Forges other than GitHub
- Self-hosted LLM backends (Claude and Codex CLIs are supported)
