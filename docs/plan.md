# Implementation Plan

Tracks remaining work against the PRD roadmap. Each item is a discrete unit of
work that can land independently. Phases follow PRD §Roadmap.

## Status legend

- ✅ Done — landed on `main`
- 🟡 Partial — exists but incomplete or buggy
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
- ✅ `superfield github forget` (clear credentials, account-type-aware uninstall URL)
- ✅ `superfield doctor`
- ✅ Calypso Blueprint integrated as git subtree at `blueprint/` with bidirectional sync workflows

## Phase 2 — Planning loop: CI watchdog 🟡

- ✅ Detect failed checks on `main` via `getCheckRuns`
- ✅ Create `ci-failure` issue with deduplication by SHA + check name
- ✅ Issue body uses unified `IssueBody` schema (Phase / Motivation / Canonical docs / Features / Test Plan)
- 🟡 **Insert ci-failure at top of Plan** — currently appends to bottom (`watchdog.ts:96`)
- 🟡 **Plan entry format** — currently `- #N — title (timestamp)`, must be `- #N — title [risk: 6]\n  <!-- superfield: {...} -->` with metadata comment
- 🟡 **Rename `runOuterLoop` → `runPlanningLoop`** to match PRD terminology
- ⬜ Plan body parser/serializer that understands `<!-- superfield: -->` metadata blocks (needed for top-insert)

## Phase 3 — Planning loop: issue audit + Plan coverage ⬜

- ⬜ `issue-audit` step: walk all open issues, check `IssueBody` schema conformance, label non-conformant ones
  - Use `buildIssueAuditPrompt` (already exists) → spawn `claude` → parse JSON → apply normalizations
  - Label: `non-conformant` + comment listing missing/forbidden sections
- ⬜ `plan-coverage` step: list all open issues, list all issues referenced in the Plan, append missing ones to the Plan in dependency order
  - Pure deterministic, no LLM call
  - Reuses Plan parser/serializer from Phase 2

## Phase 4 — Planning loop: blueprint conformance ⬜

- ⬜ Blueprint loader: parse `blueprint/rules/graph.yaml` and per-domain `blueprint/rules/blueprints/*.yaml`
- ⬜ Domain heuristic: pick candidate blueprint domains for each open issue based on labels, title, body keywords
- ⬜ Run `buildBlueprintConformancePrompt` per issue (advisory, non-blocking)
- ⬜ Post violation comments on issues citing rule IDs
- ⬜ Dedupe: don't re-post the same violation comment on subsequent runs

## Phase 5 — Agent infrastructure 🟡

- ✅ `spawnAgent` (`packages/core/agent.ts`) — spawns `claude --print --output-format json` in worktree
- ✅ Forge-stored sessions (`packages/core/sessions.ts`) — `<!-- superfield-session: -->` comments
- ✅ Deadman switch: `findStaleSessions` scans open issues at startup
- ✅ Prompt templating system (`packages/core/prompts/`) — fragments + 10 builders
- ⬜ **Tests**: snapshot tests for each prompt builder (no live `claude` invocations)
- ⬜ **Tests**: MSW tests for forge session CRUD using recorded comment fixtures
- ⬜ Worktree manager (`packages/git/worktree.ts`): create, list, prune dedicated worktrees per issue using `isomorphic-git`

## Phase 6 — `plan` command ⬜

- ⬜ Audit step (deterministic): scan open issues + PRs for schema compliance (reuses Phase 3 audit)
- ⬜ Collect step: fetch all open issues with bodies and labels
- ⬜ Evaluate step (LLM): `buildReplanEvaluatePrompt` already exists → spawn `claude` → parse JSON
- ⬜ Create scouts: for each `scout_spec` in the LLM output, create the GitHub issue with `dev-scout` label
- ⬜ Validate step: enforce strict total order, scout-first per phase, acyclic phase deps
- ⬜ Apply step: render Plan body (with `<!-- superfield: -->` metadata) and update Plan tracking issue
- ⬜ CLI wiring: `superfield plan` in `packages/cli/index.ts`

## Phase 7 — Dev loop: primary agent only ⬜

- ⬜ Plan reader: parse the Plan tracking issue body, extract ordered `PlanIssue` array from `<!-- superfield: -->` metadata
- ⬜ Select step: identify primary = top of Plan (after CI failures), check predecessors
- ⬜ Prep step: create dedicated worktree via worktree manager (Phase 5)
- ⬜ Launch step: pick the right prompt builder by `PlanIssue.kind`:
  - `dev-scout` → `buildDevScoutPrompt`
  - `feature` → `buildDevelopIssuePrompt(role: 'primary')`
  - `ci-failure` → `buildCIFailurePrompt`
- ⬜ Spawn `claude` via `spawnAgent`, persist session via `upsertSession`
- ⬜ Wait for agent exit, check issue closed, restart loop
- ⬜ Resume support: on startup, `findStaleSessions` recovers in-progress work
- ⬜ Run dev loop concurrently with planning loop (`Promise.all` in `runStart`)

## Phase 8 — Dev loop: speculative slots ⬜

- ⬜ Scout-gate check: a phase's `dev-scout` must be CLOSED before any speculative slot in that phase opens
- ⬜ Select up to N-1 speculative candidates (eligible = all deps CLOSED, in current phase)
- ⬜ Launch in parallel with primary using `buildDevelopIssuePrompt(role: 'speculative')`
- ⬜ Each speculative agent exits after its checklist completes (no PR open)
- ⬜ When primary finishes and a speculative-completed issue becomes the new primary, skip dev stage 1–3 and start at PR open
- ⬜ Configurable N (default 3) via env or config

## Phase 9 — `feature` command ⬜

- ⬜ CLI prompt: read description from stdin or argv
- ⬜ Collect context: load Plan, list open issues
- ⬜ LLM call: `buildFeatureEvaluatePrompt` → spawn `claude` → parse `IssueBody` JSON
- ⬜ Duplicate handling: if `duplicate_of` non-null, report and exit
- ⬜ Render issue body from `IssueBody` and create the GitHub issue
- ⬜ Append to Plan in correct phase position (reuses Plan serializer from Phase 2)
- ⬜ CLI wiring: `superfield feature` in `packages/cli/index.ts`

## Phase 10 — Documentation loop ⬜

- ⬜ PR-merged trigger: planning loop watches `pulls?state=closed&sort=updated` and detects `merged_at` since last poll
- ⬜ Coverage scan: `buildDocCoveragePrompt` for source files in the merged PR
- ⬜ Canonical sync: `buildDocCanonicalSyncPrompt` checks if PR is significant and emits PRD/README patches
- ⬜ Consistency check: `buildDocConsistencyPrompt` compares fractal levels
- ⬜ If any of the three produced changes, open a single doc PR with all of them
- ⬜ CI gating: ensure `.github/workflows/build.yml` and `test-*.yml` skip on doc-only diffs (`paths:` config)
- ⬜ Run concurrently with planning loop and dev loop in `runStart`

---

## Cross-cutting tech debt

- 🟡 Pre-existing TypeScript errors in `packages/cli/commands/github.ts` (line 109, 147) and `packages/cli/commands/setup.ts` (line 92, 185) — `string[] | "all"` not handled, nullable user check
- ⬜ Snapshot tests for each prompt builder
- ⬜ Integration test for the full planning loop tick (CI watchdog → issue created → Plan updated → blueprint conformance comments posted)

## Out of scope (entire roadmap)

- Slack / webhook notifications
- Web UI
- Forges other than GitHub
- Self-hosted LLM backends (only the `claude` CLI is supported)
