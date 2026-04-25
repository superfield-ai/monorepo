# Engineering Plan: Control as a Superfield CLI Subcommand

## Proposal

Merge `control` into the `superfield` CLI monorepo as a new package. The
studio server becomes `superfield control`, a subcommand of the CLI. There is
no separate `control` repo until the feature set is stable enough to warrant
one.

This solves the version coupling problem outright — studio and the dev loop
are always at the same commit — and makes the dev environment a single
checkout with two `superfield` processes.

---

## Process model

`superfield control` manages the dev loop process. The dev loop is not a
peer process the developer has to start separately — the orchestrator view
inside control starts and stops it.

```
superfield control  (:7000)
  │
  ├── HTTP server + WebSocket  (studio turns, browser UI)
  │
  ├── DevLoopProcess           (child process: superfield start <repo>)
  │     plan / dev / doc loops
  │     API server on :7837
  │           │
  │           └── HTTP (analytics read, steer write) ←── orchestrator view
  │
  └── Orchestrator view        (browser UI panel)
        start / stop dev loop
        live loop health, active slots, costs, circuit breaker
        steer / escalate active sessions
```

`superfield start` is spawned as a child process of `superfield control`
when the user clicks Start in the orchestrator view. Control holds the
`ChildProcess` handle, monitors it, and terminates it on Stop or on its own
shutdown. The dev loop's API at `:7837` is used for all reads and writes once
the process is running.

The dev loop can also run independently (as before) — control detects a
live `:7837` on startup and connects to it without spawning a new process.

---

## The shared state problem

`ApiState` uses in-memory `Map` objects. This works fine when everything is
one process. With two processes it breaks in two ways:

1. **Steers written by control are invisible to the dev loop**, because they
   land in control's memory, not the dev loop's.

2. **Dev loop state (active slots, health, costs) is invisible to control**
   unless control queries the dev loop's API server — which is fine, but
   requires the dev loop to be running.

The steer write path is the critical one. The read path (analytics) is
already solved: `GET /analytics/*` on the dev loop's API server.

### Solution: steers and escalations go through the dev loop's API

`POST /steer/context` and `POST /steer/escalate` already exist on the dev
loop's API server (port 7837). Control calls those endpoints directly. The
dev loop's in-memory `pendingSteers`/`pendingEscalations` Maps are consumed
by the loop on the next heartbeat.

This requires no shared database. The dev loop's API server is the single
write target for all steering. Control is a pure HTTP client for steering —
it never holds steering state itself.

```
Browser
  │  WebSocket  { type: 'steer', context }
  ▼
superfield control (:7000)
  │  POST /steer/context  { session_id, context }
  ▼
superfield start (:7837)   ← the actual state store
  │  ApiState.pendingSteers.set(...)
  ▼
dev loop heartbeat consumes it
```

### What about process restarts and the dev loop not running?

If `superfield start` is not running, control queues the steer locally and
retries when the dev loop API becomes reachable. Steers are not persisted
across control restarts — they are a live-session concept. If the dev loop
crashes mid-turn, the turn is lost regardless; a pending steer for a dead
session has no effect.

This is acceptable for the current scope. A durable steer queue (SQLite or
otherwise) is a future concern once the feature is validated.

### Why not SQLite now?

`bun:sqlite` is explicitly banned in the calypso app blueprint
(`IMPL-DATA-038`). That rule targets the calypso data layer, not CLI
tooling, but it signals the project's direction toward PostgreSQL. The
calypso app already runs Postgres; using SQLite for superfield IPC would
introduce a second database technology into the workspace. More importantly,
the HTTP-API approach described above needs no new storage at all — the
dev loop process IS the shared state. Add SQLite only if durable steer
queues become a real requirement.

---

## Monorepo restructure

```
superfield/cli/
  packages/
    cli/          — existing, gains control.ts command
    core/         — existing, gains api-server POST /studio/run
    git/          — unchanged
    github/       — unchanged
    studio/       — NEW: studio HTTP server (moved from control/)
      src/
        index.ts         — server startup (was control/apps/server/src/index.ts)
        router.ts
        api.ts
        agent.ts         — now calls POST /studio/run on superfield API
        claude-session.ts — now streams from superfield API
        studio-ws.ts     — NEW: WebSocket handler
        ...
      tests/
        unit/
        integration/
      package.json
```

The `control/apps/web/` browser UI, `control/packages/db/`, and
`control/packages/core/` move into analogous locations under `cli/packages/`.

The `control` directory and its GitHub workflows are retired once the move
is complete.

---

## Orchestrator view

The orchestrator view is a panel in the control browser UI (route
`/studio/orchestrator`) that manages the dev loop lifecycle and surfaces its
runtime state.

### What it shows

**Loop status bar** — sourced from `GET /analytics/loops` polled every 5 s:

| Loop | Last tick | Duration | Idle reason | Circuit |
|------|-----------|----------|-------------|---------|
| plan | 12 s ago  | 340 ms   | —           | closed  |
| dev  | 4 s ago   | 1.2 s    | —           | closed  |
| doc  | 58 s ago  | 210 ms   | no changes  | closed  |

**Active slots** — sourced from `GET /analytics/slots` SSE-streamed or polled:
- One card per active issue: issue number, title, slot role (primary /
  speculative), backend, model, elapsed time, live heartbeat indicator.
- Steer button on each card: opens an inline textarea → sends
  `POST /steer/context` with the session's `sessionId`.
- Escalate button: sends `POST /steer/escalate` with `issueNumber`.

**Cost summary** — sourced from `GET /analytics/costs`:
- Total USD spent this session, per-backend breakdown, agent count, error
  count.

**Circuit breaker** — sourced from `GET /analytics/circuit`:
- Tripped / closed indicator. Consecutive failures count. Auto-resets when
  the dev loop recovers.

**Process controls:**
- **Start** button — disabled if dev loop is already running. Spawns
  `superfield start <repo>` as a child process. Button becomes **Stop**.
- **Stop** button — sends SIGTERM to the child process. Waits for clean
  exit; sends SIGKILL after 5 s timeout.
- Process status badge: `stopped` / `starting` / `running` / `stopping`.
- Dev loop stdout/stderr tail — last N lines in a scrollable log pane,
  streamed via `GET /orchestrator/logs` SSE endpoint.

### New backend endpoints in `packages/studio/src/`

**`GET /orchestrator/status`** — returns dev loop process state:
```json
{ "process": "running" | "stopped" | "starting" | "stopping",
  "pid": 12345,
  "apiReachable": true,
  "uptimeMs": 94000 }
```

**`POST /orchestrator/start`** — spawns `superfield start <repo>`. Body:
```json
{ "repo": "/absolute/path", "slotCount": 3 }
```
Returns `{ ok: true, pid }` or `{ ok: false, reason }` if already running.

**`POST /orchestrator/stop`** — sends SIGTERM to the managed process.
Returns `{ ok: true }`.

**`GET /orchestrator/logs`** — SSE stream of the dev loop's combined
stdout/stderr. Each event is one log line. Reconnects automatically if the
process restarts.

### New module: `packages/studio/src/dev-loop-process.ts`

Manages the child process lifecycle:

- `spawn(repo, opts)` — calls `Bun.spawn(['superfield', 'start', repo, ...])`,
  captures stdout/stderr into a ring buffer (last 500 lines), emits events
  for status changes and log lines.
- `stop()` — SIGTERM → 5 s → SIGKILL.
- `status()` — returns current `ProcessState`.
- `isApiReachable()` — probes `GET <apiUrl>/health`.

On `superfield control` startup, `DevLoopProcess` checks whether a
superfield API is already reachable at the configured `--api-url`. If yes,
it enters `running` (externally managed) state without spawning a new
process.

---

## UX tooling: kitchen sink split

The kitchen sink from `demos/teamster/apps/kitchen-sink/` contains two
distinct categories of tooling that go to two different destinations.

### Category A — Design system display (→ starter template)

These features belong in every new project scaffolded from
`superfield/template`. They help developers working on the calypso app see
their own components and design tokens without running the backend.

**What moves to `template/apps/kitchen-sink/`:**

- The standalone Vite app shell (`main.tsx`, `KitchenSink.tsx`, section nav)
- `bun run kitchen-sink` script on port 5174
- **Design token section** — Tailwind color palette, typography scale,
  spacing scale, shadow/radius scale derived from `tailwind.config`
- **Component catalogue section** — one card per component showing all
  meaningful states (default, loading, error, disabled, empty). Ships nearly
  empty in the starter; developers populate it as they build components.
- **Fixture pattern** — static JSON in `src/fixtures/`, zero API calls
- Excluded from Docker and CI build matrix by default

The teamster-specific sections (Operator Dashboard, Carrier PWA, CRM,
Customer Service, Admin) do not move to the starter — they are
domain-specific and will exist as examples within their demo repo.

### Category B — Meta UX design tools (→ control)

These features are useful during a live studio session where a designer is
iterating on the application. They live inside the control browser UI as a
dev-mode route (`/studio/preview`) — not as a separate Vite app — because
they need to be accessible from within the studio browser session without
switching ports.

**What moves to `cli/packages/studio/apps/web/src/`:**

- **Component preview panel** (`/studio/preview`) — renders any component in
  isolation with static fixture data. During a studio turn, the agent can
  modify a component and the designer sees it here immediately, without
  restarting the backend or navigating to a live page.
- **WikiRender** + **CitationHoverPopover** — agent-output display
  components already relevant to the studio's turn log and session
  documentation view.
- The **mock view pattern** (full-page interactive views with fixture data)
  as a design review tool — the designer can open `/studio/preview/crm`,
  `/studio/preview/admin`, etc. to see their current components in a
  realistic layout with realistic data.

These routes are only rendered when studio mode is active
(`isStudioMode() === true`). They are not included in production builds of
the calypso app itself.

### Source extraction

The teamster kitchen sink imports its components from
`apps/web/src/components/`. When adapting for the starter and control, the
components themselves are not copied — only the kitchen sink shell and the
fixture-driven rendering harness. Each project provides its own components.

---

## Changes required

### 1. New package: `cli/packages/studio/`

Move all `control/apps/server/src/` code here. Update imports. Add
`package.json` declaring it as `@superfield/studio` with `workspace:*`
deps on `@superfield/core` and `@superfield/git`.

### 2. New subcommand: `superfield control`

**File:** `cli/packages/cli/commands/control.ts`

```
superfield control [--port <n>] [--repo <path>] [--api-url <url>]

  --port      Studio server port. Default: 7000.
  --repo      Repo root (CALYPSO_REPO_ROOT). Default: cwd.
  --api-url   Superfield API base URL. Default: http://127.0.0.1:7837.
```

Starts the studio HTTP server from `@superfield/studio`. Does not start any
loops. Does not read `~/.superfield/config.yaml`. The only external
dependency is the superfield API server at `--api-url`.

At startup, control pings `GET <api-url>/health`. If unreachable it logs a
warning and starts anyway — agent turns will fail at request time with a
clear error, but status/commit/rollback routes continue to work.

### 3. Superfield core — new `POST /studio/run` endpoint

**File:** `cli/packages/core/api-server.ts`

```
POST /studio/run

Request body:
  message       string   — the user turn
  repoRoot      string   — absolute path the agent works in
  sessionKey    string?  — resume an existing session (optional)
  allowedTools  string   — comma-separated tool list
  mode          string   — 'design' | 'question'

Response: SSE stream
  event: session   data: { sessionId }        — once, before first chunk
  (default)        data: <stdout chunk>        — one per chunk
  event: done      data: { filesChanged: [] } — turn complete
  event: error     data: <message>            — spawn failure or non-zero exit
```

Spawns `claude` with the same args as `spawnAgentBackend` but streams
`stdout` chunk-by-chunk via `res.write()` instead of buffering. Registers
the subprocess in `ApiState` slot tracking.

### 4. Studio — replace `Bun.spawn` with HTTP calls

**`packages/studio/src/agent.ts`** — `runAgent()` calls
`POST <SUPERFIELD_API_URL>/studio/run`, collects the full SSE body into a
string, returns it. Call signature unchanged.

**`packages/studio/src/claude-session.ts`** — `streamTurn()` calls
`POST <SUPERFIELD_API_URL>/studio/run` with `{ duplex: 'half' }` and pipes
the SSE response body directly into the `ReadableStream` controller. Parses
`event: session` to capture `sessionId`.

### 5. Studio — WebSocket handler

**`packages/studio/src/studio-ws.ts`**

Bun's native WebSocket API (`server.upgrade()`). One socket per studio
session.

| Frame in | Action |
|---|---|
| `{ type: 'turn', message }` | calls `streamTurn()`, forwards chunks as `{ type: 'chunk', text }`, sends `{ type: 'done', sessionId, filesChanged }` on completion |
| `{ type: 'steer', context }` | calls `POST <SUPERFIELD_API_URL>/steer/context` with the active `sessionId`, replies `{ type: 'steer-ack', requestId }` |

On disconnect: cancels the in-flight SSE fetch.

**`packages/studio/src/router.ts`** — adds `GET /studio/ws` upgrade path.

### 6. Studio — steer proxy (REST fallback)

**`packages/studio/src/router.ts`** — adds `POST /studio/steer`.

Validates body, proxies to `POST <SUPERFIELD_API_URL>/steer/context` using
the active `sessionId`. For callers that cannot use WebSocket (integration
tests, curl).

---

## Development environment

Both processes run from the same monorepo checkout. No version mismatch is
possible.

```bash
# Terminal 1 — dev loop (plan/dev/doc) + API server
cd superfield/cli
SUPERFIELD_DEV=1 bun packages/cli/bin/superfield.ts start <repo-path>
# API server on :7837, loop logs go to a fresh tmpdir

# Terminal 2 — studio server
cd superfield/cli
bun packages/cli/bin/superfield.ts control \
  --repo <repo-path> \
  --api-url http://127.0.0.1:7837
# Studio on :7000
```

### Filesystem isolation

`SUPERFIELD_DEV=1` is set only on the dev loop process. Effects:

| Path | Dev loop (`SUPERFIELD_DEV=1`) | Control |
|---|---|---|
| `~/.superfield/config.yaml` | read (GitHub tokens needed for loops) | not read |
| `~/.superfield/logs/` | NOT written — uses `mkdtemp` tmpdir | not written |
| `/tmp/superfield-worktrees/` | used for issue clones | not used |
| `<repo>/.studio` | read by studio to get sessionId/branch | read |
| `<repo>/docs/studio-sessions/` | not touched | written |

The studio server's only filesystem writes are:
- `<STUDIO_LOG_DIR>/YYYY-MM-DD.jsonl` — turn logs (defaults to tmpdir or
  `../studio-logs` relative to repo root)

### Running without the dev loop

Control can run standalone — useful when developing the studio UI without
wanting the dev loop to process real GitHub issues. Agent turns will return
a `503 Superfield API unavailable` error, but all other studio routes
(status, commits, rollback, chat history) work.

To test agent turns without the dev loop, point `--api-url` at a minimal
stub server that implements only `POST /studio/run`.

---

## Testing strategy

### Unit tests

Location: `cli/packages/studio/tests/unit/` (same structure as current
`control/apps/server/tests/unit/`).

`agent.ts` and `claude-session.ts` tests stub `fetch` instead of
`Bun.spawn`. Everything else is unchanged.

### Integration tests

Location: `cli/packages/studio/tests/integration/`.

New fixture `tests/integration/helpers/superfield-server.ts` starts the
superfield API server in-process on a random port using the claude stub on
`PATH`. The studio server's `SUPERFIELD_API_URL` is set to this fixture's
URL. No k3d required.

```typescript
export async function startSuperfieldFixture(): Promise<{
  apiUrl: string;
  stop: () => void;
}>;
```

Tests that currently skip via `clusterAvailable()` can move here once they
only need the superfield HTTP server and Postgres.

### E2E tests (k3d + Playwright)

Two containers in the k8s test cluster:
- `superfield-studio` — `cli/packages/studio/` compiled + entrypoint, runs
  `superfield control`
- `superfield-agent` — CLI image, runs `superfield start` (no loops, API
  only via a future `--no-loops` flag or mocked loop deps), with claude stub

The claude stub moves from the studio image to the agent image. The studio
image has no claude dependency.

### CI matrix

| Workflow | Runner | Services | Notes |
|---|---|---|---|
| `ci.yml` | ubuntu-latest | none | build + typecheck + unit |
| `ci-integration.yml` | ubuntu-latest | postgres | superfield fixture in-process, no k3d |
| `ci-e2e.yml` | ubuntu-latest | k3d | two images, both with stub |
| `ci-browser.yml` | ubuntu-latest | none | component tests, unchanged |

---

## Rollout order

1. **Move studio source into `cli/packages/studio/`** — mechanical port,
   all existing tests pass.

2. **Add `superfield control` subcommand** — wires up the studio server,
   no behaviour change yet.

3. **Add `POST /studio/run` to superfield API server** — self-contained
   addition, ships independently.

4. **Replace `Bun.spawn` in `agent.ts` and `claude-session.ts`** — unit
   tests switch from spawn stub to fetch stub. Integration tests use the
   new superfield fixture.

5. **Add WebSocket handler** — additive. Browser migrates to WebSocket;
   existing SSE endpoint removed once migration is confirmed.

6. **Add `/studio/steer` proxy** — additive, enables mid-turn steering.

7. **Add `dev-loop-process.ts` and orchestrator backend endpoints** —
   `GET /orchestrator/status`, `POST /orchestrator/start`,
   `POST /orchestrator/stop`, `GET /orchestrator/logs`.

8. **Add orchestrator view in browser UI** — loop status bar, active slots,
   cost summary, circuit breaker, start/stop controls, log tail.

9. **Kitchen sink → starter template** — add `apps/kitchen-sink/` to
   `superfield/template` with design token section and empty component
   catalogue shell.

10. **Kitchen sink → control** — add `/studio/preview` route to control's
    browser UI with component preview panel, WikiRender, CitationHoverPopover,
    and mock view pattern.

11. **Retire the `control/` directory and its CI workflows** — after all
    prior steps are green on main.

---

## Implementation notes (cli-migration branch, 2026-04-25)

### Phase 1 (completed)
- `packages/studio/` was already partially migrated on main; remaining work
  was fixing unit tests and adding the `_readProc` DI parameter to `runAgent`.
- `packages/studio-core/` and `packages/db/` copied from control and already
  tracked on main.

### Phase 2 (completed)
- `packages/cli/commands/control.ts` parses `--port`, `--repo`, `--api-url`,
  pings dev-loop health on startup (warns if unreachable), then delegates
  to `startStudio()`.
- `packages/studio/src/index.ts` refactored to export `startStudio(opts?)`
  instead of side-effect startup. Server only starts when called explicitly.
- `SUPERFIELD_API_URL` (default `http://127.0.0.1:7837`) added to `StudioConfig`.

### Phase 3 (completed)
- `POST /studio/run` SSE endpoint added to `packages/core/api-server.ts`.
  Spawns claude, streams stdout as SSE, emits `event: session/done/error`.
- `runAgent()` in studio now calls `POST /studio/run`, collects SSE body.
  Uses `_fetch` DI parameter for testability.
- `streamTurn()` in studio fetches `POST /studio/run`, pipes SSE to browser.
  Uses `_fetch` DI parameter for testability.
- Integration fixture `tests/integration/helpers/superfield-server.ts` starts
  API server in-process with claude stub on PATH.
- Claude stub at `tests/fixtures/claude`.

### Phase 4 (completed)
- `packages/studio/src/studio-ws.ts` — Bun native WebSocket handler.
- `GET /studio/ws` upgrade path and `POST /studio/steer` REST fallback in router.
- `WsChatController` added to `ChatController.ts` alongside existing SSE controller.
- `route()` signature updated to accept optional Bun server reference.

### Phase 5 (completed)
- `packages/studio/src/dev-loop-process.ts` — manages `superfield start` lifecycle.
- `packages/studio/src/orchestrator.ts` — GET/POST /orchestrator/* endpoints.
- `OrchestratorController.ts` + `OrchestratorView.tsx` added to browser UI.
- Orchestrator tab added to StudioPanel nav.

### Phase 6 (completed)
- `template/apps/kitchen-sink/` — standalone Vite app (port 5174) with design
  token section and component catalogue shell. Excluded from Docker + CI build.
- `packages/studio/apps/src/components/WikiRender.tsx` and `CitationHoverPopover.tsx`
  ported from teamster kitchen sink (self-contained, no external API deps).
- `ComponentPreviewPanel.tsx` added for `/studio/preview` route.
- Preview tab added to StudioPanel.

### Phase 7 (completed)
- `.github/workflows/ci-studio.yml` added: build/typecheck + unit tests +
  integration tests with in-process superfield fixture (no k3d).

### Phase 8 (completed)
- Deprecation banner added to `control/README.md`.
- All control GitHub Actions workflows renamed to `.yml.disabled`.
- `control/` repo `cli-migration` branch pushed to origin for archival.

