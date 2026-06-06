# Calypso Studio — Test Plan

## Testing Pyramid

```
                    ┌───────────────────────────────┐
                    │        Browser / E2E           │  Playwright + headless Chromium
                    │    (real k8s + full UI)        │  Slowest · Fewest
                    └───────────────────────────────┘
                  ┌─────────────────────────────────────┐
                  │         Integration Tests           │  Node.js · k8s · mocked Claude
                  │  (real cluster, stubbed externals)  │  & OAuth interception
                  └─────────────────────────────────────┘
              ┌───────────────────────────────────────────┐
              │       React Component Tests (View)        │  vitest-browser-react
              │   (components wired to mock controllers)  │  Chromium in-process
              └───────────────────────────────────────────┘
         ┌─────────────────────────────────────────────────────┐
         │              Browser Controller Unit Tests          │  Vitest browser mode
         │     (pure TS logic, no React, headless Chromium)    │  Chromium in-process
         └─────────────────────────────────────────────────────┘
    ┌───────────────────────────────────────────────────────────────┐
    │                    Server Unit Tests                          │  Vitest · Bun runtime
    │          (pure functions, no I/O, no browser)                 │  Fastest · Most
    └───────────────────────────────────────────────────────────────┘
```

---

## Architecture: Controllers and Views

The web layer (`apps/web/src/`) separates business logic from rendering:

- **Controllers** (`apps/web/src/controllers/`) — pure TypeScript classes/modules that own
  state, API calls, and SSE streams. No React imports. Browser APIs only (`fetch`, `EventSource`,
  `ReadableStream`, `localStorage`). Independently unit-testable.
- **Views** (`apps/web/src/components/`) — React components that receive controller state via
  props or context and render it. Contain no fetch calls or stream logic directly.

### Planned controller modules

| Controller | Extracted from | Responsibilities |
|------------|---------------|-----------------|
| `ChatController.ts` | `ChatPanel.tsx`, `StudioChat.tsx` | Send message, accumulate streaming SSE chunks, maintain message history, expose turn state (idle / streaming / error) |
| `ClusterStatusController.ts` | `ClusterStatusIndicator.tsx`, `StudioPanel.tsx` | Connect to `/studio/cluster/events` SSE, parse pod events, derive aggregate status (healthy / restarting / degraded / unknown), reconnect on drop |
| `OAuthController.ts` | `OAuthPanel.tsx` | Fetch OAuth init URL, submit confirmation code, persist connected state, expose status (disconnected / pending / connected / error) |
| `CommitController.ts` | `StudioChat.tsx` | Fetch commit log, trigger rollback, refresh history after each chat turn |

---

## Layer 1a — Server Unit Tests

**Tooling:** Vitest 2, Bun runtime
**Location:** `apps/server/tests/unit/`
**Run command:** `bun --bun vitest run apps/server/tests/unit`

### Scope

Pure logic tests for server-side code with no network, filesystem, subprocess, or browser
involvement. All I/O replaced with `vi.fn()` / `vi.spyOn()` doubles.

### Current coverage

| Module | Tests | Status |
|--------|-------|--------|
| `studio-helpers.ts` | 11 | ✓ |
| `hot-swap.ts` | 9 | ✓ |
| `claude-session.ts` | 14 | ✓ |
| `router.ts` | 8 | ✓ |
| `cluster-events.ts` | 11 | ✓ |
| `process-manager.ts` | 6 | ✓ |
| `studio-start.ts` | 10 | ✓ |
| `api.ts` | 0 | ✗ missing |
| `config.ts` | 0 | ✗ missing |
| `agent.ts` | 0 | ✗ missing |
| `auth.ts` | 0 | ✗ missing |
| `git.ts` | 0 | ✗ missing |

### Gaps to fill

- **`config.ts`** — env-var parsing, defaults, validation errors.
- **`auth.ts`** — JWT generation, cookie serialisation, HMAC signature verification, expiry
  handling (no HTTP server).
- **`git.ts`** — `getChangedFiles` parsing, branch detection, commit-log formatting using
  fixture stdout strings.
- **`api.ts`** — route registration, middleware ordering, CORS preflight logic.

---

## Layer 1b — Browser Controller Unit Tests

**Tooling:** Vitest 2 browser mode, Playwright provider, headless Chromium
**Location:** `apps/web/tests/unit/`
**Config:** `apps/web/vitest.config.ts` (browser mode, no React plugin)
**Run command:** `bun --bun vitest run --config apps/web/vitest.config.ts --project unit`

### Scope

Unit tests for the controller layer. No React, no DOM rendering — only the controller class
under test plus browser-native APIs (`fetch`, `EventSource`, `ReadableStream`). External HTTP
calls are intercepted via `vi.stubGlobal('fetch', ...)` or a Service Worker mock.

Tests run in headless Chromium (not Node.js) because controllers use browser-native APIs that
are absent from the Bun/Node.js runtime.

### Test matrix

| Controller | Scenarios |
|------------|-----------|
| `ChatController` | Initial state is idle; `send()` sets state to streaming; SSE chunks accumulate in message list in order; `event: done` transitions state to idle; non-200 response sets error state; calling `send()` while streaming is a no-op |
| `ClusterStatusController` | Connects to SSE on construction; pod event with READY=1/1 STATUS=Running produces `healthy`; pod event with STATUS=Terminating produces `restarting`; CrashLoopBackOff produces `degraded`; stream close triggers reconnect after 2 s |
| `OAuthController` | Initial status is `disconnected`; `initiate()` calls `GET /api/auth/oauth/init` and sets status to `pending` with returned URL; `complete(code)` posts code and sets status to `connected`; error response sets status to `error` with message |
| `CommitController` | `fetchCommits()` returns parsed commit list; `rollback(sha)` posts to `/studio/rollback`; `fetchCommits()` is called automatically after rollback |

---

## Layer 2 — React Component Tests (View)

**Tooling:** Vitest 2 + `vitest-browser-react` + `@vitest/browser` (Playwright provider, headless Chromium)
**Location:** `apps/web/tests/component/`
**Run command:** `bun --bun vitest run --config apps/web/vitest.config.ts --project component`

### Scope

React components rendered into a real Chromium DOM. Each component receives a **mock
controller** as a prop or context value. Tests verify that the component renders controller
state correctly and calls the right controller methods on user interaction. No fetch calls
are made — the controller is fully doubled.

### Test matrix

| Component | Scenarios |
|-----------|-----------|
| `ChatPanel` | Renders message history from controller state; input disabled when controller state is streaming; submit calls `controller.send(message)`; displays streaming chunks as they arrive in controller state |
| `IframePanel` | Renders iframe at `src`; shows reloading overlay when `clusterStatus="restarting"`; hides overlay when `clusterStatus="healthy"`; reloads iframe on restarting→healthy transition |
| `ClusterStatusIndicator` | Green for healthy; amber pulsing for restarting; red for degraded; gray for unknown |
| `OAuthPanel` | Shows "not connected" for `disconnected` status; Initiate button calls `controller.initiate()`; displays URL from `pending` state; code input calls `controller.complete(code)`; shows connected state; shows error message from `error` state |
| `StudioPanel` | Renders ChatPanel and IframePanel; passes cluster status from `ClusterStatusController` to both; layout intact at 1280×800 |
| `StudioChat` | Renders commit list from `CommitController`; rollback button calls `commitController.rollback(sha)`; commit list refreshes after chat turn |

### Config

```ts
// apps/web/vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        name: 'unit',
        test: {
          browser: { enabled: true, provider: 'playwright', name: 'chromium', headless: true },
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        name: 'component',
        test: {
          browser: { enabled: true, provider: 'playwright', name: 'chromium', headless: true },
          include: ['tests/component/**/*.test.tsx'],
        },
      },
    ],
  },
});
```

Add to root `package.json`:
```json
"test:browser-unit": "bun --bun vitest run --config apps/web/vitest.config.ts --project unit",
"test:component":    "bun --bun vitest run --config apps/web/vitest.config.ts --project component"
```

---

## Layer 3 — Integration Tests

**Tooling:** Node.js `node:test` + `assert`
**Location:** `tests/integration/`
**Run command:** `for f in tests/integration/*.test.ts; do node --test "$f" || exit 1; done`

### Why Node.js for this layer

The k8s integration layer involves spawning `kubectl`, port-forwarding, and cluster lifecycle
operations. Node.js's mature `child_process` and stream APIs, plus the wider npm ecosystem for
cluster helpers, make it the right runtime here. The studio server process under test runs
independently with its own Bun runtime.

### Infrastructure setup

Each test suite acquires a **test namespace** in the local k3s cluster, provisions a blank
Calypso stack into it, and tears it down on completion.

#### Shared helpers

```
tests/integration/helpers/
  cluster.ts       — namespace create/delete, kubectl apply kustomize overlay
  port-forward.ts  — kubectl port-forward wrapper, returns { host, port, close() }
  wait-ready.ts    — poll kubectl until all deployments Available (configurable timeout)
  oauth-proxy.ts   — in-process HTTP intercept proxy for outbound OAuth traffic
  claude-stub.ts   — writes bash stub to temp dir, prepends to PATH
```

#### Blank Calypso containers

The integration test overlay uses `k8s/overlay/kustomization.yaml` targeting a dedicated test
namespace. Containers are the **real Calypso images** (api, web, agents) from the local
registry. Postgres runs as the same StatefulSet as production. No mocked services inside the
cluster.

#### Mocked Claude CLI

A bash stub is placed on `PATH` before the studio server starts:

```bash
#!/usr/bin/env bash
# tests/fixtures/claude-stub
echo "stub invoked: $*" >> "$CLAUDE_STUB_LOG"
echo "Test response to: $1"
```

`CLAUDE_STUB_LOG` points to a known temp path. Tests assert invocation arguments by reading
the log after each chat turn. The stub can be swapped per-test for a multi-chunk variant to
exercise streaming.

#### OAuth interception

An in-process HTTP proxy intercepts outbound OAuth calls. The studio server is configured with
`OAUTH_BASE_URL=http://localhost:<proxy_port>`:

```ts
const oauthProxy = await startOAuthProxy({
  '/oauth/init':     { url: 'https://fixture.example/oauth?state=abc' },
  '/oauth/complete': { access_token: 'fixture-token-123' },
});
process.env.OAUTH_BASE_URL = oauthProxy.baseUrl;
afterAll(() => oauthProxy.close());
```

Tests assert against `oauthProxy.requests` to verify correct payloads were forwarded.

### Test matrix

| Suite | File | Scenarios |
|-------|------|-----------|
| Cluster provisioning | `cluster-lifecycle.test.ts` | Namespace created; overlay applies; all deployments reach Available; port-forwards open |
| Auth API | `auth-api.test.ts` | Register user; login returns JWT cookie; protected endpoint rejects without cookie |
| Chat flow | `chat-flow.test.ts` | POST `/studio/chat` invokes Claude stub with correct args; JSONL log entry written; changed files in git diff detected |
| Chat streaming | `chat-streaming.test.ts` | GET `/studio/chat/stream` delivers SSE chunks as stub emits; `event: done` closes stream; client disconnect stops process |
| Hot-swap trigger | `hot-swap.test.ts` | File change after chat turn triggers rebuild; pod deleted and returns Ready; response includes `servicesRestarted: ["api"]` |
| Rollback | `rollback.test.ts` | POST `/studio/rollback` resets HEAD; GET `/studio/commits` no longer includes rolled-back commit |
| OAuth flow | `oauth-flow.test.ts` | Init hits proxy and returns URL; complete posts code; proxy recorded correct payloads |
| Cluster events SSE | `cluster-events.test.ts` | GET `/studio/cluster/events` streams pod watch events; deleting a pod produces restarting then healthy event |

---

## Layer 4 — Browser / E2E Tests

**Tooling:** Playwright 1.x, headless Chromium
**Location:** `tests/e2e/`
**Run command:** `npx playwright test`
**Infrastructure:** same k8s helpers as Layer 3 (`tests/integration/helpers/`)

### Scope

Full user journeys through the studio UI in a real headless browser. Playwright controls
Chromium while the same k8s stack (Claude stub, OAuth proxy) runs in the background.

### Structure

```
tests/e2e/
  pages/
    StudioPage.ts      — top-level page, cluster status indicator, iframe
    ChatPage.ts        — message input, send button, history, rollback
    OAuthPage.ts       — OAuth status, initiate button, code input
  fixtures/
    studio.fixture.ts  — Playwright fixture: provisions cluster + starts studio server
  specs/
    studio-load.spec.ts
    chat-turn.spec.ts
    streaming.spec.ts
    hot-swap.spec.ts
    oauth-connect.spec.ts
    rollback.spec.ts
    cluster-status.spec.ts
```

### Shared Playwright fixture

```ts
// tests/e2e/fixtures/studio.fixture.ts
export const test = base.extend<{ studioPage: StudioPage }>({
  studioPage: async ({ page }, use) => {
    const cluster = await provisionCluster();
    const server  = await startStudioServer({ cluster, claudeStub: true, oauthProxy: true });
    await page.goto(server.url);
    await use(new StudioPage(page));
    await server.stop();
    await cluster.teardown();
  },
});
```

### Test scenarios

| Spec | Steps | Assertions |
|------|-------|------------|
| `studio-load` | Navigate to `/` | Studio panel visible; iframe loads `/app/`; cluster status indicator shows healthy |
| `chat-turn` | Type message, click Send | Message in history; loading indicator during stub run; reply appears; commit added |
| `streaming` | Send message with multi-chunk stub | Each chunk appears in the UI before turn completes |
| `hot-swap` | Send message that modifies a server file | Status indicator transitions restarting → healthy; iframe reloads |
| `oauth-connect` | Click Initiate; enter fixture code | URL displayed; panel shows connected; proxy received correct payloads |
| `rollback` | Send two messages; click Rollback on first commit | Second message removed from commit list |
| `cluster-status` | Force-delete a pod via kubectl | Indicator transitions restarting → healthy without page reload |

### Playwright config

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e/specs',
  timeout: 120_000,
  use: {
    headless: true,
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: [['html', { open: 'never' }]],
});
```

---

## Running the full suite

```bash
# Layer 1a — Server unit tests
bun --bun vitest run apps/server/tests/unit

# Layer 1b — Browser controller unit tests
bun --bun vitest run --config apps/web/vitest.config.ts --project unit

# Layer 2  — React component tests
bun --bun vitest run --config apps/web/vitest.config.ts --project component

# Layer 3  — Integration (sequential)
for f in tests/integration/*.test.ts; do node --test "$f" || exit 1; done

# Layer 4  — Browser E2E
npx playwright test
```

---

## Coverage

Add `@vitest/coverage-v8` for Layers 1a and 1b:

```ts
coverage: {
  provider: 'v8',
  include: ['apps/server/src/**', 'apps/web/src/controllers/**'],
  reporter: ['text', 'lcov'],
  thresholds: { lines: 80, functions: 80 },
}
```

Coverage is not collected at Layers 2–4 — those layers validate contracts and user journeys,
not line coverage.

---

## Open questions

1. **k3s in CI** — Layers 3 and 4 require a running k3s instance. CI must use a self-hosted
   runner with k3s pre-installed or use `k3d` to spin up a cluster inside the pipeline.
2. **Calypso image registry** — `bun run build` must run before the integration suite; images
   must be available in the local containerd store or a registry mirror.
3. **OAuth provider base URL** — The outbound OAuth base URL must be confirmed once
   `auth.ts` OAuth calls are located, to ensure `OAUTH_BASE_URL` overrides the right constant.
4. **Studio server port conflicts** — Each integration suite should set `STUDIO_PORT` to a
   random free port to avoid collisions when suites run in parallel.
