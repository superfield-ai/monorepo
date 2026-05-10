# Scout: C-11 Check-Run Data Surfaces and SSE Integration Seam

**Issue:** #294
**Phase:** C-11 (scout gate)
**Feeds:** #293 (C-11 app-development UI feedback)

---

## Findings Summary

No check-run data surfaces exist in the frontend today. The backend plumbing
(GitHub client + watchdog loop) already polls check-runs but writes results
only to GitHub issues, never to `ApiState` or any `/analytics/` endpoint.
C-11.1–11.4 are greenfield additions to three existing component files plus
one optional new SSE endpoint.

---

## 1. Existing `/analytics/` Endpoints — What They Expose

The superfield API server (`packages/core/api-server.ts`) exposes:

| Endpoint | Data surfaced |
|---|---|
| `GET /analytics/status` | activeSlots, loopHealth, totalCostUsd, agentCount, errorCount |
| `GET /analytics/slots` | Full slot objects (sessionId, issueNumber, slot, role, startedAt, elapsedMs) |
| `GET /analytics/sessions` | Session list |
| `GET /analytics/loops` | Plan/dev/doc loop health |
| `GET /analytics/costs` | Cost aggregates |
| `GET /analytics/circuit` | Circuit-breaker state (tripped, consecutiveFailures) |

**Gap**: None of these endpoints surface check-run data. `CheckRun` objects
(`packages/github/client.ts:3`) are polled by `runWatchdogStep()` in
`packages/core/loop.ts:430` but results are never written to `ApiState`. There
is no `/analytics/check-runs` or `/analytics/pr-status` endpoint.

The Control router (`packages/control/src/router.ts:404`) proxies all
`/analytics/*` requests to `superfieldApiUrl`. Any new `/analytics/check-runs`
endpoint added to the superfield API server would be proxied automatically.

---

## 2. Call Path from GitHub Check-Runs to the Frontend (today — none exists)

```
GitHubClient.getCheckRuns(owner, repo, sha)   — packages/github/client.ts:160
  ↓ polled by
runWatchdogStep()                              — packages/core/loop.ts:423-468
  ↓ result is
    hasFailedChecks() → creates ci-failure GitHub issue only
  ↓ NEVER reaches
    ApiState / api-server / /analytics/ / frontend
```

The `TurnSummary` interface (backend `packages/control/src/turns.ts:20`,
frontend `packages/control/apps/src/components/TurnTimeline.tsx:26`) does not
include `commitSha`, `prNumber`, or any CI status fields. The
`GET /studio/turns/:sessionId` endpoint reads JSONL turn logs that also carry
no check-run information.

---

## 3. Component Files C-11.1–C-11.4 Will Touch

| Sub-issue | File | Nature of change |
|---|---|---|
| C-11.1 | `packages/control/apps/src/components/TurnTimeline.tsx` | Add `CheckRunBadge` on each turn row; requires `commitSha` on `TurnSummary` |
| C-11.2 | `packages/control/apps/src/components/VisualDiffPanel.tsx` | Add expandable `TestOutputPane` below the diff; requires ANSI→HTML rendering |
| C-11.3 | `packages/control/apps/src/components/OrchestratorView.tsx` | New `CiStatusFeed` section; may need new `/analytics/check-runs/stream` SSE |
| C-11.4 | `packages/control/apps/src/components/OrchestratorView.tsx` | One-click escalate button; calls `POST /steer/escalate` (already implemented) |

---

## 4. C-10 Primitives — No Naming Conflicts

Existing C-10 exports (all from `packages/control/apps/src/components/`):

- `WsChatController` / `WsChat` — `controllers/ChatController.ts`, `chat/WsChat.tsx`
- `TurnTimeline` / `TurnSummary` — `TurnTimeline.tsx`
- `VisualDiffPanel` / `VisualDiffData` — `VisualDiffPanel.tsx`
- `OrchestratorView` / `OrchestratorController` — respective files

Proposed C-11 additions (`CheckRunBadge`, `CiStatusFeed`, `TestOutputPane`) do
not clash with any existing export name. Import paths follow the established
pattern: new components live under `apps/src/components/` and are added to
`apps/src/components/index.ts`.

---

## 5. Integration Points and Risks for C-11 Implementors

### Risk 1 — `commitSha`/`prNumber` absent from `TurnSummary`

`TurnSummary` carries no SHA or PR reference. C-11.1 has two options:

- **Option A** (preferred): Add `commitSha?: string` and `prNumber?: number` to
  the JSONL turn log (written in `packages/core/loops/dev-loop.ts`) and to the
  `TurnSummary` interface in `packages/control/src/turns.ts`. The frontend can
  then call a new `/analytics/check-runs?sha=<sha>` endpoint per turn row.

- **Option B** (workaround): Derive the SHA at fetch time by joining
  `/analytics/slots` (has `sessionId`) against the GitHub API for the active PR.
  Higher latency, no turn-level granularity.

### Risk 2 — ApiState does not store check-run results

`runWatchdogStep()` (`packages/core/loop.ts:423`) calls `getCheckRuns()` and
discards the result (only creates GitHub issues). C-11.3 needs either:

- A new `state.checkRuns: CheckRun[]` field on `ApiState` populated by the
  watchdog step, exposed via a new `/analytics/check-runs` endpoint, or
- A thin SSE endpoint that polls GitHub check-runs directly in the Control server.

The second option avoids changes to the core API state but adds a new
network fan-out in the control process.

### Risk 3 — ANSI rendering for C-11.2

No ANSI→HTML library is in the current control or control-apps dependencies.
Options: `ansi-to-html` (~10 kB), `ansi_up` (MIT, 8 kB), or a minimal
DIY regex approach (~20 lines). Recommend `ansi-to-html` for correctness.

### Risk 4 — SSE endpoint placement for C-11.3

The Control router proxies `/analytics/*` → `superfieldApiUrl` (line 404 of
`router.ts`). A new SSE route at `/analytics/check-runs/stream` would need to
be intercepted **before** that proxy block, or the superfield API server must
implement it (then it is proxied automatically). The superfield API server
(`packages/core/api-server.ts`) does not use Bun's native `Response` streaming
but does use Node.js `ServerResponse.write()` for SSE — an SSE addition there
follows the existing `POST /studio/run` pattern.

### Risk 5 — `POST /steer/escalate` (C-11.4)

Already implemented in `packages/core/api-server.ts:207`. The Control server
proxies `POST /studio/steer` → `superfieldApiUrl/steer/context`. There is no
direct `/studio/steer/escalate` proxy path yet; C-11.4 will need either a new
proxy stub in `router.ts` or must call `superfieldApiUrl/steer/escalate`
directly from the browser (CORS consideration).

---

## References

- `packages/github/client.ts` — `CheckRun` interface, `getCheckRuns()` method
- `packages/core/loop.ts:423-468` — `runWatchdogStep()` (watchdog polling)
- `packages/core/api-server.ts` — all `/analytics/*` and `/steer/*` endpoints
- `packages/control/src/turns.ts` — `TurnSummary` interface and JSONL reader
- `packages/control/src/router.ts` — `/analytics/*` proxy block (line 404)
- `packages/control/apps/src/components/TurnTimeline.tsx` — C-11.1 target
- `packages/control/apps/src/components/VisualDiffPanel.tsx` — C-11.2 target
- `packages/control/apps/src/components/OrchestratorView.tsx` — C-11.3, C-11.4 target
- `docs/plan.md § Phase C-9` — upstream phase context
- Issue #293 comment: https://github.com/superfield-ai/superfield-cli-ts/issues/293#issuecomment-4416569106
