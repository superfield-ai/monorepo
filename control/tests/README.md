# Test Suite Overview

## Layers

| Layer | Description | Runner | Location |
|-------|-------------|--------|----------|
| 1 | Unit tests — pure logic, no I/O | Vitest | `apps/server/tests/unit/`, `packages/core/tests/` |
| 2 | Integration tests — real HTTP, DB, subprocess | Vitest | `apps/server/tests/integration/` |
| 3 | End-to-end — full cluster lifecycle | Vitest | `tests/integration/` |
| 4 | Browser E2E — Playwright against live UI | Playwright | `tests/e2e/`, `tests/browser/` |

## Running Tests

```bash
# Layer 1 — unit tests (< 10s)
bun run test:unit

# Layer 2 — server integration tests (requires postgres)
bun run test:integration

# Layer 3 — cluster lifecycle (requires k3s + calypso-studio:e2e image)
# Run individual files from tests/integration/

# Layer 4 — browser E2E (requires running k3s cluster + calypso-studio:e2e image + Playwright)
bun run test:e2e
```

## E2E Prerequisites

Layer 3 and Layer 4 tests deploy the studio server into a k3s cluster using a
container image (`calypso-studio:e2e`) built from the `Dockerfile` at the repo
root. Before running E2E tests locally:

```bash
# 1. Ensure k3s/k3d is running and KUBECONFIG is set
kubectl cluster-info

# 2. Build the E2E container image
docker build -t calypso-studio:e2e .

# 3. Import the image into k3d (if using k3d)
k3d image import calypso-studio:e2e

# 4. Install Playwright browsers (first time only)
npx playwright install chromium --with-deps

# 5. Run E2E tests
bun run test:e2e
```

See `docs/studio-e2e-infrastructure.md` for the full architecture, what the
container contains, and how the CI workflow (`ci-e2e.yml`) sets all of this up
automatically.

## Known Gaps

### Resolved (Issue #23)

- ~~**Heavy mocking in api.test.ts** — vi.mock replaced agent, git, and fs
  modules, hiding cross-module interface breaks.~~ Fixed: api.test.ts now
  calls through the real module graph; only outermost I/O (fs, readProcStdout)
  is mocked.

- ~~**globalThis.Bun patching in agent.test.ts** — per-test patching of the
  Bun global was fragile and hid real Bun.spawn argument assembly.~~ Fixed:
  a vitest setup file (bun-shim.ts) provides a stable Bun stub; tests spy on
  the provided global instead of patching it.

- ~~**Missing negative-path coverage** — error responses for malformed input,
  missing fields, and edge cases were under-tested.~~ Fixed: each server
  unit test file (api, agent, git) now includes at least 2 negative-path cases.

- ~~**No tsc in CI** — type errors only surfaced at runtime.~~ Fixed: CI
  workflow now runs `tsc --noEmit` for every package with a tsconfig.json.

### Open

- **Performance / load testing** — no systematic load or latency benchmarks
  exist for the studio server under concurrent sessions.

- **k3s-dependent tests require real cluster** — Layer 3 and 4 tests require
  a live k3s cluster. The `ci-e2e.yml` workflow provisions one automatically
  using `nolar/setup-k3d-k3s` (k3s-in-Docker) before running Playwright. The
  fixture fails hard (not skips) when no cluster is reachable so misconfigured
  CI is immediately visible.

## Confidence Grade

**A-** — Unit tests cover all server modules with real cross-module boundaries,
negative paths, and type checking in CI. Integration and E2E layers are present
but require infrastructure (Postgres, k3s, browser) that limits CI coverage.
