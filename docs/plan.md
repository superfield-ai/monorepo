# Superfield — Implementation Plan

Current build status. For product scope see [`product.md`](./product.md); for delivery sequence see [`roadmap.md`](./roadmap.md).

## Status legend

- ✅ Done — landed on `main`
- 🟡 Partial — exists but has known correctness gaps
- ⬜ Not started

---

## Track A — GitOps Orchestrator

### Phase A-1 — Foundation ✅

- ✅ Monorepo: `packages/cli`, `packages/core`, `packages/github`, `packages/git`
- ✅ Config read/write at `~/.superfield/config.yaml`
- ✅ `@octokit/rest` client wrapper with MSW test harness
- ✅ `isomorphic-git` wrapper with MSW test harness
- ✅ GitHub Actions CI: build, unit tests, integration tests
- ✅ Golden fixtures recorder (`bun record-fixtures`)
- ✅ `superfield github add` (device flow + app installation polling + repo registration)
- ✅ `superfield github forget` (account-type-aware uninstall URL)
- ✅ Superfield Blueprint integrated as git subtree at `blueprint/`

### Phase A-2 — Planning loop: CI watchdog ✅

- ✅ Detect failed checks on `main` via `getCheckRuns`
- ✅ Create `ci-failure` issue with deduplication by SHA + check name
- ✅ Insert ci-failure at top of Plan via `Plan` parser/serializer
- ✅ `packages/core/plan.ts` parser + 17 unit tests

### Phase A-3 — Planning loop: issue audit + Plan coverage ✅

- ✅ `runIssueAudit` — LLM-driven schema conformance via `buildIssueAuditPrompt`; issues processed in batches of 25 (up to 3 concurrent), result shape `{ audited, nonConformant[], reports: Record<number, IssueAuditReport> }`; non-conformant issues body-rewritten and labelled `non-conformant`; incremental state cache on Plan issue skips unchanged issues (10-min TTL)
- ✅ `runPlanCoverage` — deterministic placement for issues declaring `## Phase`; LLM batch placement (Haiku, `buildPlanPlacementPrompt`) for issues without a declared phase; LLM can place into existing phases or create new ones; result shape `{ appended, alreadyCovered, skipped, llmPlaced, createdPhases, planCreated }`
- ✅ `runLLMTask` reusable helper with `extractJson`

### Phase A-4 — Planning loop: blueprint conformance ✅

- ✅ `loadBlueprint` — parses `blueprint/rules/graph.yaml` + per-domain yamls
- ✅ `runBlueprintConformance` — LLM-driven advisory check, posts `<!-- superfield-blueprint -->` comments

### Phase A-5 — Agent infrastructure ✅

- ✅ `spawnAgent` (`packages/core/agent.ts`) — `claude` / `codex` subprocess wrapper
- ✅ Forge-stored sessions (`packages/core/sessions.ts`) — `<!-- superfield-session: -->` comments
- ✅ Prompt templating system (`packages/core/prompts/`) — fragments + 10 builders
- ✅ Snapshot tests for all 10 prompt builders
- ✅ Worktree manager (`packages/git/worktree.ts`) using isomorphic-git

### Phase A-6 — `plan` command ✅

- ✅ `runPlanCommand` — collect → evaluate (LLM) → create-scouts → validate → apply
- ✅ `validateProposal` — duplicate detection, scout-first, acyclic phase deps

### Phase A-7 — Dev loop: primary agent ✅

- ✅ `runDevLoop` / `tickDevLoop` — primary-only loop
- ✅ `selectPrimary` — ci-failures first, then phase issues

### Phase A-8 — Dev loop: speculative slots ✅

- ✅ `selectSpeculative` — scout-gated; only opens if phase scout is CLOSED on `main`
- ✅ Configurable `slotCount` (default 3 = 1 primary + 2 speculative)

### Phase A-9 — `feature` command ✅

- ✅ `runFeatureCommand` — collect → evaluate (LLM) → handle duplicate → create issue → append to Plan

### Phase A-10 — Documentation loop ✅

- ✅ `runDocLoop` / `tickDocLoop` — third concurrent loop
- ✅ `openDocPR` — creates `docs/auto-N` branch, applies patches via Contents API, opens PR

### Phase A-11 — Analytics & Steering API ✅

- ✅ `ApiState` — shared in-memory state object passed to all three loops
- ✅ `startApiServer` — in-process HTTP server on `127.0.0.1:7837`
- ✅ Analytics endpoints: `/health`, `/analytics/status`, `/analytics/slots`, `/analytics/loops`, `/analytics/costs`, `/analytics/circuit`
- ✅ Steering endpoints: `/steer/context`, `/steer/escalate`
- ✅ Wired into `superfield start` with `--no-api` and `--api-port` flags
- ✅ Loops instrumented with `recordLoopTick`, `recordAgentStart`, `recordAgentEnd`

### Phase A-12 — `audit` command 🟡

- ✅ `superfield audit --path <dir>` — audit an app repo against expected blueprint capabilities
- ✅ Initial capability set: `property-graph-db`, `authentication`, `error-tracing`, `pwa`
- ✅ Per-capability agent call via `spawnAgent` (`jobType: "audit"`, `maxTurns: 100`)
- ✅ Findings saved incrementally to `<output-dir>/<capability-id>.json` (resume on crash)
- ✅ Summary written to `<output-dir>/summary.json`
- ✅ Gap → GitHub issue in blueprint issue format (skipped when `--no-issues` or no `--repo`)
- ✅ `"audit"` job type registered in job registry (medium dev spec)
- ⬜ Expand capability set: derive from `loadBlueprintSync()` filtering `type === "checklist"` instead of hardcoded `CAPABILITIES` in `audit/capabilities.ts`
- ⬜ Parallel capability runs
- ⬜ Stale-check: skip re-running capabilities where finding mtime > repo HEAD mtime

### Cross-cutting A (remaining)

- ✅ All three loops wired in `superfield start` (`packages/cli/commands/start.ts`)
- ✅ Planning-loop integration test (`tests/integration/planning-loop.test.ts`, 306 lines) — uses mock GitHubClient, not MSW
- ✅ Dev-loop integration test (`tests/integration/dev-loop.test.ts`, 318 lines) — uses recorded fixtures + GitHub MSW stubs
- 🟡 Doc-loop integration test — stub only (32 lines); scenarios covered by unit tests in `tests/unit/doc-loop.test.ts`

---

## Track B — Ops / Deploy CLI

### Phase B-0 — GitHub API client ✅

- ✅ Deploy key CRUD, repo secrets push, PR creation via `@octokit/rest`

### Phase B-1 — Bootstrap ✅

- ✅ `scripts/install.sh` — k3s install + sshd hardening
- ✅ TS orchestrator connects over SSH and runs install script

### Phase B-2 — Cloud providers ✅

- ✅ GCP: VM + optional AlloyDB (`packages/core/commands/remote-provision.ts`)
- ✅ DigitalOcean: Droplet + optional Managed PG
- ✅ AWS: EC2 + optional RDS
- ✅ Vultr: VM

### Phase B-3 — GitHub environment setup ✅

- ✅ Per-env deploy key registration (`setup-github` step 1)
- ✅ Per-env Actions secrets push (`DEPLOY_HOST_<ENV>`, `DEPLOY_KEY_<ENV>`, `DATABASE_URL_<ENV>`)
- ✅ Workflow YAML templates synced via PR (`sync-workflows`)

### Phase B-4 — Kubernetes manifests ✅

- ✅ Distroless container build (`Dockerfile`)
- ✅ Postgres StatefulSet with named PVC
- ✅ One-shot DB migration Job

### Phase B-5 — Deployment commands ✅

- ✅ `deploy-env` — rolling update: build → push image → apply manifests → health gate
- ✅ `deploy-env --clean-room` — fresh PVC + seed Job, old PVC preserved
- ✅ `rollback-env` — roll back to previous deployment

### Phase B-6 — Operator CLI 🟡

- ✅ `doctor` — SSH, k3s, DB, and secrets reachability checks (has bugs — see below)
- ✅ `init` — one-shot: provision → setup-github → deploy (has bugs — see below)
- ✅ `destroy` — tear down deployment with prod safety gate
- ✅ `export-db` — pg_dump for local postgres, snapshot for managed DB (has bugs — see below)

### Cross-cutting B (remaining)

- ✅ Extract shared `resolveEnvCredentials(env)` — landed in PR #208
- ✅ AWS RDS: real SigV4 signing — landed in PR #202

---

## Track C — Control Webapp

Spec: [`product.md` § Control Webapp](./product.md#control-webapp). Implementation contract: [`architecture.md` § Control Webapp](./architecture.md#control-webapp). Track C landed in PR #204 (merged 2026-04-26).

### Phase C-1 — Move studio source into `cli/packages/control/` ✅

- ✅ Source ported from the standalone `control` repo
- ✅ Unit tests passing with DI `_readProc` parameter on `runAgent`
- ✅ `packages/control-core/` and `packages/db/` tracked on main

### Phase C-2 — `superfield control` subcommand ✅

- ✅ `packages/cli/commands/control.ts` parses `--port`, `--repo`, `--api-url`
- ✅ Pings dev-loop `/health` on startup; warns if unreachable, starts anyway
- ✅ `startControl(opts?)` exported from `packages/control/src/index.ts` (no side-effect startup)

### Phase C-3 — `POST /studio/run` SSE on superfield API ✅

- ✅ Endpoint added to `packages/core/api-server.ts`
- ✅ Streams claude stdout chunk-by-chunk; emits `event: session/done/error`
- ✅ `runAgent()` and `streamTurn()` switched from `Bun.spawn` to `fetch`
- ✅ Integration fixture `tests/integration/helpers/superfield-server.ts` + claude stub

### Phase C-4 — WebSocket + steer proxy ✅

- ✅ `packages/control/src/control-ws.ts` — Bun native WebSocket handler
- ✅ `GET /studio/ws` upgrade path, `POST /studio/steer` REST fallback
- ✅ `WsChatController` alongside the existing SSE controller

### Phase C-5 — Orchestrator (process + view) ✅

- ✅ `packages/control/src/dev-loop-process.ts` — child-process lifecycle
- ✅ `packages/control/src/orchestrator.ts` — `/orchestrator/*` endpoints
- ✅ `OrchestratorController.ts` + `OrchestratorView.tsx` in browser UI
- ✅ Orchestrator tab in ControlPanel nav

### Phase C-6 — Studio preview + kitchen-sink split ✅

- ✅ `template/apps/kitchen-sink/` shipped with design-token section + empty catalogue shell (port 5174, excluded from Docker + CI)
- ✅ `WikiRender.tsx`, `CitationHoverPopover.tsx` ported into control
- ✅ `ComponentPreviewPanel.tsx` at `/studio/preview`

### Phase C-7 — CI ✅

- ✅ `.github/workflows/ci-control.yml` — build + typecheck + unit + in-process integration (no k3d)

### Phase C-8 — Retire standalone `control/` repo ✅

- ✅ Deprecation banner on `control/README.md`
- ✅ All control workflows renamed to `.yml.disabled`
- ✅ `cli-migration` branch pushed to origin for archival

### Phase C-9 — Demo-readiness extensions 🟡

Scoped for the 2026-04-28 client demo. Source spec: `architecture.md § Control Webapp` (Phase 9 routes).

| Item                                            | Pillar             | Status |
| ----------------------------------------------- | ------------------ | ------ |
| C-9.1 Per-route preview map                     | Iterative dev      | ✅     |
| C-9.2 Design-tokens panel                       | UX design          | ✅     |
| C-9.3 Mock-route gallery                        | UX design          | ⬜     |
| C-9.4 Viewport toolbar                          | Iterative dev / UX | ✅     |
| C-9.5 Deployment health view (`/studio/deploy`) | Deployment health  | ✅     |
| C-9.6 Turn timeline + prompt inspector          | Agent monitoring   | ✅     |
| C-9.7 Blueprint conformance feed                | Agent monitoring   | ⬜     |
| C-9.8 `scripts/seed-demo.ts`                    | Demo               | ✅     |

### Cross-cutting C (post-demo)

- ✅ Merge PR #204 to main
- ✅ Archive `superfield-studio` GitHub repo (archived 2026-05-04)
- ⬜ Per-turn screenshot capture into `docs/studio-sessions/`
- ⬜ Visual diff before / after a turn
- ⬜ Cost-over-time sparkline; log search/filter; slot heartbeat history
- ⬜ DB-migration Job log tail on the deploy view
- ⬜ Fixture switcher per route, persisted in `<repo>/.studio/`
