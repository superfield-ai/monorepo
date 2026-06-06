# Studio E2E Infrastructure

How the studio server is deployed, what it needs at runtime, and how the
E2E test infrastructure provides all of that in a local k3d cluster.

---

## Studio Server Architecture

The studio server is a **Bun HTTP server** (`apps/server/src/index.ts`) that
acts as the single network ingress point for a studio session:

```
Browser
  │
  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Studio Server  0.0.0.0:STUDIO_PORT (default 7000, E2E: 3000)          │
│                                                                         │
│  GET /*                  → serve built React UI (apps/web/dist/)        │
│  GET /app/*              → reverse-proxy → svc/web:80 (nginx)           │
│  GET /api/*              → reverse-proxy → svc/api:31415 (product API) │
│  GET /studio/cluster/events → SSE: kubectl cluster-info health poll    │
│  GET /studio/chat/stream    → SSE: Claude CLI turn stream               │
│  POST /studio/chat          → run Claude agent, create checkpoint       │
│  POST /api/auth/register    → in-memory user registration               │
│  POST /api/auth/login       → in-memory user login (JWT cookie)         │
│  POST /studio/rollback      → git reset HEAD to prior commit            │
│  ... (see router.ts for full route table)                               │
└─────────────────────────────────────────────────────────────────────────┘
         │                         │
         ▼                         ▼
   svc/web:80               Claude CLI (stub in tests, real binary at runtime)
   (nginx stub in E2E)      spawned as subprocess by agent.ts / claude-session.ts
```

### What the server reads from the environment

| Variable | Default | Purpose |
|---|---|---|
| `STUDIO_PORT` | `7000` | Port the Bun HTTP server listens on |
| `STUDIO_ASSETS_DIR` | _(unset)_ | Absolute path to built React UI (`apps/web/dist/`) |
| `STUDIO_WEB_SERVICE_HOST` | `127.0.0.1` | Hostname for the `/app/*` reverse-proxy target |
| `STUDIO_WEB_SERVICE_PORT` | `8080` | Port for the `/app/*` reverse-proxy target |
| `STUDIO_API_SERVICE_HOST` | `127.0.0.1` | Hostname for the `/api/*` reverse-proxy target |
| `STUDIO_API_SERVICE_PORT` | `31415` | Port for the `/api/*` reverse-proxy target |
| `STUDIO_CLUSTER_CONTEXT` | `default` | kubectl context used by ClusterEventStream and `cluster-status-sse.ts` |
| `STUDIO_LOG_DIR` | `../studio-logs` | Directory for Claude CLI response JSONL logs |
| `CALYPSO_REPO_ROOT` | `process.cwd()` | Root of the git repo that the session operates on |
| `CLAUDE_STUB_LOG` | _(unset)_ | Log file path for the claude-stub binary (E2E tests only) |

### What the server needs on disk / PATH

| Requirement | Runtime (production) | E2E tests |
|---|---|---|
| `git` binary | Host git installation | Installed in `Dockerfile` |
| `kubectl` binary | Host kubectl + kubeconfig | Installed in `Dockerfile`, in-cluster kubeconfig set by `docker-entrypoint.sh` |
| `claude` binary | Real Claude CLI | `tests/fixtures/claude-stub` bash script on PATH |
| Git repo at `CALYPSO_REPO_ROOT` | Product repo | Initialised by `docker-entrypoint.sh` |
| `.studio` file at repo root | Written by `studio-start.ts` | Written by `docker-entrypoint.sh` |
| Browser UI at `STUDIO_ASSETS_DIR` | Built from `apps/web/` | Built in Docker image (Stage 1 of `Dockerfile`) |

### The `.studio` file

`isStudioMode()` in `api.ts` checks for the existence of `.studio` at
`CALYPSO_REPO_ROOT`. If missing, all `/studio/*` routes (except status)
return `403 Studio mode is not active`.

The file is parsed by `parseStudioInfo()` in `helpers.ts`. It must be valid JSON
containing exactly two string fields:

```json
{"sessionId":"<unique-session-id>","branch":"<git-branch-name>"}
```

At runtime this is written by `studio/scripts/studio-start.ts`. In E2E tests
it is written by `docker-entrypoint.sh`.

---

## Runtime Startup (Calypso App)

To start a studio session against a running Calypso product repo:

```bash
# From the product repo root (where the studio submodule is checked out):
bun run studio                    # → studio/scripts/studio-start.ts
```

`studio-start.ts` performs these steps:

1. Validates the current git branch is a `studio/session-*` branch.
2. Starts an isolated Postgres container (`packages/db/pg-container.ts`).
3. Creates `docs/studio-sessions/<branch>/changes.md` and commits it.
4. Writes `.studio` with `sessionId` and `branch`.
5. Starts the HTTP server at `STUDIO_PORT`.

**Prerequisites on the host:**

- `bun` ≥ 1.0
- `kubectl` configured for the target cluster (context named `default` by default)
- `git` installed and the product repo fully cloned
- `claude` (Claude CLI) installed and authenticated
- `docker` available if rebuild-on-change is needed

**The browser UI** (`apps/web/dist/`) must be built separately and pointed to
via `STUDIO_ASSETS_DIR`:

```bash
# Build the React UI once before starting the studio server:
cd apps/web && bunx vite build
export STUDIO_ASSETS_DIR="$(pwd)/apps/web/dist"
bun run studio
```

---

## Test-Time Infrastructure

### Layer 3 — Integration tests (Vitest, Node.js, real k3s)

**Location:** `apps/server/tests/integration/`, `tests/integration/`
**Run:** `bun run test:integration`

These tests start the real studio server process as a subprocess, run kubectl
commands against a live k3s cluster, and assert on HTTP responses.

**What the tests set up:**

1. `createNamespace(ns)` — creates a unique k8s namespace
2. `applyManifests(ns)` — runs `kubectl apply -f k8s/base/ -n ns`
3. `waitReady(ns, timeout)` — polls until all Deployments are Available
4. `portForward(ns, target, localPort, remotePort)` — opens a `kubectl port-forward`

**What `k8s/base/` deploys:**

| Resource | Purpose |
|---|---|
| `k8s/base/studio.yaml` | Studio Deployment (image `calypso-studio:e2e`) + Service `api:3000` |
| `k8s/base/web.yaml` | nginx Deployment + Service `web:80` (target for `/app/*` proxy) |
| `k8s/base/rbac.yaml` | ClusterRole + ClusterRoleBinding for pod-reader access |

**Claude stub:** `installClaudeStub()` copies `tests/fixtures/claude-stub` to a temp
directory, prepends it to `PATH`, and sets `CLAUDE_STUB_LOG`. The studio server process
inherits this environment and resolves `claude` to the stub.

### Layer 4 — Browser E2E tests (Playwright + k3s)

**Location:** `tests/e2e/`
**Run:** `bun run test:e2e` (or `npx playwright test`)
**CI workflow:** `.github/workflows/ci-e2e.yml`

The Playwright fixture (`tests/e2e/fixtures/studio.fixture.ts`) does the full
cluster lifecycle on each test:

```
clusterAvailable()              → kubectl cluster-info (fail hard if no cluster)
createNamespace(ns)             → unique namespace per test run
applyManifests(ns)              → kubectl apply -f k8s/base/ -n ns
waitReady(ns, 120_000)          → all Deployments Available
portForward(ns, svc/api, 0, 3000)  → get host:port for serverUrl
page.goto(serverUrl)            → Playwright browser navigates to the studio UI
```

**The studio container** (`calypso-studio:e2e`) is built by `Dockerfile` in the repo
root and imported into k3d before the tests run. It is a two-stage build:

- Stage 1: `oven/bun:1` — builds `apps/web/` with Vite → `apps/web/dist/`
- Stage 2: `oven/bun:1` — copies server source + built UI, installs kubectl + git,
  copies `tests/fixtures/claude-stub` to `/usr/local/bin/claude`

**`docker-entrypoint.sh`** runs when the container starts inside k3s:

1. Reads the ServiceAccount token from `/var/run/secrets/kubernetes.io/serviceaccount/`
   and writes an in-cluster kubeconfig to `/tmp/kubeconfig` with context `default`.
2. Initialises a git repo at `/studio-repo` and writes `.studio` to enable studio mode.
3. Starts `bun run src/index.ts` from `apps/server/`.

**Why `imagePullPolicy: Never`:** The image is imported directly into k3d's containerd
(via `k3d image import calypso-studio:e2e`) and does not exist in any remote registry.

### CI workflow: `.github/workflows/ci-e2e.yml`

The complete E2E job sequence:

```yaml
1. actions/checkout@v4              # check out the repository
2. nolar/setup-k3d-k3s@v1          # start a k3d-managed k3s cluster (version v1.29)
   k3s-args: --disable=traefik     # disable traefik ingress (not needed)
3. ./.github/actions/setup-bun     # install Bun runtime
4. docker build -t calypso-studio:e2e .    # build the E2E container image
5. k3d image import calypso-studio:e2e     # load image into k3d containerd
6. bunx playwright install chromium --with-deps  # install browser
7. bunx playwright test                    # run tests/e2e/specs/sanity.spec.ts
8. upload /tmp/studio-pod-logs/ always     # pod logs captured before namespace deletion
9. upload playwright-report/ on failure
```

**`nolar/setup-k3d-k3s` pulls `rancher/k3s:<version>` from Docker Hub.** On shared
GitHub Actions runners this occasionally times out with a transient network error
(`Client.Timeout exceeded`). Re-running the workflow resolves it — the failure is
Docker Hub rate-limiting or a momentary outage, not a code issue.

**Why `nolar/setup-k3d-k3s`:** This action starts k3s inside Docker (k3d), sets
`KUBECONFIG` automatically, and exposes a cluster that accepts local image imports
via `k3d image import`. The fixture's `clusterAvailable()` check will pass because
the cluster is ready before the test script runs.

**Why `k3d image import` instead of a registry:** Building to and pulling from a
container registry adds minutes and requires credentials. Importing the locally-built
image directly into k3d's containerd cache is instant and works without any registry
setup.

---

## RBAC in the E2E Cluster

The studio server runs inside a pod and needs to call `kubectl cluster-info` to
derive the cluster health status emitted by the `/studio/cluster/events` SSE endpoint.

`k8s/base/rbac.yaml` creates:

| Resource | Name | Grants |
|---|---|---|
| `ClusterRole` | `studio-e2e-pod-reader` | `get/list/watch` on pods and pod logs |
| `ClusterRoleBinding` | `studio-e2e-pod-reader` | Binds `system:serviceaccounts` (all SAs) to the role |

The `ClusterRoleBinding` subject uses `kind: Group` with `name: system:serviceaccounts`
so that ANY ServiceAccount in ANY namespace gets read access. This avoids the namespace
mismatch problem: each E2E test creates a unique namespace
(`calypso-e2e-<timestamp>-<random>`), and the studio pod runs as the `default` SA in
that namespace. A namespace-specific `RoleBinding` would need to know the namespace at
manifest-apply time, which `kubectl apply -f` cannot infer from the `-n <ns>` flag
alone.

**Security note:** Granting `system:serviceaccounts` cluster-wide pod-reader access is
acceptable for ephemeral E2E test clusters. Do not apply `k8s/overlay/` to a production
cluster.

---

## How the Cluster Status Becomes "healthy"

The `studio-load.spec.ts` E2E test asserts that the cluster status indicator shows
"healthy" within 60 seconds. This requires the SSE endpoint to emit a `cluster-status`
event with `{"status":"healthy"}`.

The endpoint is implemented in `apps/server/src/cluster-status-sse.ts`:

1. On connection, it runs `kubectl --context default cluster-info --request-timeout=3s`.
2. If exit code is 0 → emits `event: cluster-status\ndata: {"status":"healthy"}`.
3. If non-zero → emits `{"status":"unknown"}`.
4. Polls every 5 seconds.

Inside the k3s pod, the in-cluster kubeconfig (set up by `docker-entrypoint.sh`) points
to the k3s API server. The `kubectl cluster-info` command hits the API server discovery
endpoints (`/api`, `/apis`) which are accessible with the mounted ServiceAccount token
and the default `system:discovery` ClusterRole (granted automatically by k3s).

No additional RBAC is needed for `kubectl cluster-info`.

---

## File Map

```
calypso-studio/
│
├── Dockerfile                         ← Two-stage image: web build + runtime
├── docker-entrypoint.sh               ← In-cluster kubeconfig + git init + bun start
│
├── apps/
│   ├── server/src/
│   │   ├── index.ts                   ← Bun.serve() entrypoint, SIGTERM handler
│   │   ├── router.ts                  ← Complete route dispatch (see route table above)
│   │   ├── config.ts                  ← StudioConfig loaded from env vars
│   │   ├── api.ts                     ← /studio/* handlers (all require JWT auth)
│   │   ├── auth.ts                    ← In-memory user store, JWT sign/verify, cookies
│   │   ├── agent.ts                   ← Bun.spawn('claude', ['-p', prompt, ...])
│   │   ├── cluster-events.ts          ← ClusterEventStream: kubectl get pods --watch
│   │   └── cluster-status-sse.ts      ← GET /studio/cluster/events SSE handler
│   │
│   └── web/
│       ├── index.html                 ← Vite HTML entry point
│       ├── vite.config.ts             ← Vite build config (React plugin)
│       └── src/
│           ├── main.tsx               ← createRoot → <StudioPanel />
│           ├── components/            ← React components (StudioPanel, ClusterStatus…)
│           └── controllers/           ← Pure TS: ClusterStatusController, ChatController…
│
├── k8s/
│   └── base/
│       ├── studio.yaml                ← Deployment (calypso-studio:e2e) + Service api:3000
│       ├── web.yaml                   ← nginx Deployment + Service web:80
│       └── rbac.yaml                  ← ClusterRole + ClusterRoleBinding (pod-reader)
│
├── tests/
│   ├── fixtures/
│   │   └── claude-stub                ← Bash stub: logs args to CLAUDE_STUB_LOG
│   ├── integration/helpers/
│   │   ├── cluster.ts                 ← createNamespace, applyManifests, deleteNamespace, capturePodLogs
│   │   ├── port-forward.ts            ← kubectl port-forward, returns { host, port, close }
│   │   ├── wait-ready.ts              ← polls kubectl get deployments until Available
│   │   ├── claude-stub.ts             ← installClaudeStub() → PATH mutation + cleanup
│   │   └── oauth-proxy.ts             ← in-process HTTP server for OAuth interception
│   └── e2e/
│       ├── fixtures/studio.fixture.ts ← Playwright fixture: full cluster lifecycle
│       ├── pages/                     ← StudioPage, ChatPage, OAuthPage
│       └── specs/
│           ├── sanity.spec.ts         ← Active: 4 baseline tests (panel, status, chat, reply)
│           └── *.spec.ts              ← Held back until sanity suite is stable (see testMatch)
│
└── .github/workflows/
    ├── ci-e2e.yml                     ← k3d + docker build + playwright
    ├── ci-integration.yml             ← postgres service + vitest integration
    ├── ci-browser.yml                 ← Playwright browser-unit + component tests
    └── ci.yml                         ← Unit tests + typecheck
```
