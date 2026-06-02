# Scout Report: CLI and Control API Contracts

**Issue:** #375  
**Phase:** CLI, deploy tooling, and serving backend in Rust  
**Scope:** Inventory of control/app API endpoints and operator/agent CLI commands

---

## 1. Control Server API Endpoints

The control server is implemented in `packages/control/src/` (Bun/TypeScript).
The router is in `packages/control/src/router.ts`.

### 1.1 Authentication Endpoints (no JWT required)

| Method | Path | Description | Handler |
|--------|------|-------------|---------|
| POST | `/api/auth/register` | Create in-memory user, set JWT cookie | `auth.ts` |
| POST | `/api/auth/login` | Verify credentials, set JWT cookie | `auth.ts` |
| GET/POST | `/api/auth/oauth/status` | Query OAuth connection status | `auth.ts` |
| GET/POST | `/api/auth/oauth/init` | Begin OAuth device-code flow, returns auth URL | `auth.ts` |
| POST | `/api/auth/oauth/complete` | Complete OAuth with confirmation code | `auth.ts` |

### 1.2 Studio SSE/WebSocket Streams (no JWT required)

| Method | Path | Description | Handler |
|--------|------|-------------|---------|
| GET | `/studio/chat/stream?message=<text>&mode=<design\|question>` | SSE: Claude CLI turn stream | `claude-session.ts` |
| GET | `/studio/cluster/events` | SSE: aggregate cluster health | `cluster-status-sse.ts` |
| GET | `/studio/debug/events` | SSE: backend error/warning stream for browser DebugStore | `debug-events.ts` |
| GET | `/studio/ws` | WebSocket: chat/steer stream (WS upgrade) | `control-ws.ts` |

### 1.3 Studio REST Endpoints (JWT cookie required)

| Method | Path | Description | Handler |
|--------|------|-------------|---------|
| POST | `/studio/steer` | REST fallback for steer; proxies to superfieldApiUrl/steer/context | `router.ts` |
| POST | `/studio/rebuild` | Start async image rebuild job; returns `{ jobId }` | `rebuild.ts` |
| GET | `/studio/rebuild/log?job=<id>` | SSE stream of rebuild job output | `rebuild.ts` |
| GET | `/studio/status` | Studio mode active? Returns sessionId, branch, commits, timeline | `api.ts` |
| GET | `/studio/commits` | Session commit log since fork point | `api.ts` |
| GET | `/studio/timeline` | Checkpoint timeline with timestamps | `api.ts` |
| POST | `/studio/rollback` | Hard-reset HEAD to prior commit hash `{ hash }` | `api.ts` |
| POST | `/studio/reset` | Clear in-memory session messages + Claude resume id | `api.ts` |
| POST | `/studio/chat` | Run Claude agent one turn `{ message }` | `api.ts` |
| POST | `/studio/debug/trace` | Append browser trace entry to trace log | `api.ts` |

### 1.4 Studio Issues/Sync Endpoints (no auth guard in current code)

| Method | Path | Description | Handler |
|--------|------|-------------|---------|
| GET | `/studio/issues[?status=<status>]` | List local issues; filter by status | `api.ts` |
| POST | `/studio/issues` | Create local issue; optional pushToGithub | `api.ts` |
| PATCH | `/studio/issues/:number` | Patch title/body/status of an issue | `api.ts` |
| POST | `/studio/sync/github` | Manual GitHub sync trigger | `api.ts` |

### 1.5 Studio Deploy Endpoints

| Method | Path | Description | Handler |
|--------|------|-------------|---------|
| GET | `/studio/deploy/envs` | List envs from DEPLOY_HOST_<ENV> vars (GitHub or fallback) | `deploy.ts` |
| GET | `/studio/deploy/doctor/:env` | Run preflight checks for env | `deploy.ts` |
| GET | `/studio/deploy/secrets/:env` | Audit required secrets/vars presence | `deploy.ts` |
| GET | `/studio/deploy/ci` | Latest workflow runs on main for deploy-<env> workflows | `deploy.ts` |
| POST | `/studio/deploy/rollback/:env` | Start rollback job `{ confirm: true }` → `{ jobId }` | `deploy.ts` |
| GET | `/studio/deploy/rollback-log?job=<id>` | SSE stream of rollback job lines | `deploy.ts` |
| GET | `/studio/deploy/migration-log?env=<env>` | SSE tail of k8s migration Job (kubectl logs) | `deploy.ts` |

### 1.6 Studio Docs Endpoints

| Method | Path | Description | Handler |
|--------|------|-------------|---------|
| GET | `/studio/docs` | List .md filenames from docs/ | `docs.ts` |
| GET | `/studio/docs/:filename` | Return raw markdown content | `docs.ts` |

### 1.7 Studio Turns/Screenshots Endpoints

| Method | Path | Description | Handler |
|--------|------|-------------|---------|
| GET | `/studio/turns/:sessionId` | Turn timeline entries from JSONL logs | `turns.ts` |
| GET | `/studio/screenshots/:sessionId` | List per-turn PNG screenshots | `screenshots.ts` |
| GET | `/studio/screenshots/:sessionId/:filename` | Serve individual PNG | `screenshots.ts` |
| GET | `/studio/screenshots/diff/:sessionId/:before/:after` | Before/after diff metadata | `screenshots.ts` |

### 1.8 Studio Mock-Routes / Conformance / Fixtures Endpoints

| Method | Path | Description | Handler |
|--------|------|-------------|---------|
| GET | `/studio/mock-routes` | List registered mock routes | `mock-routes.ts` |
| POST | `/studio/mock-routes/:id/toggle` | Toggle a mock route on/off | `mock-routes.ts` |
| GET | `/studio/conformance` | List blueprint conformance results | `conformance.ts` |
| POST | `/studio/conformance` | Update conformance results (agent-posted) | `conformance.ts` |
| GET | `/studio/fixtures?route=<route>` | List fixtures for a route | `fixtures.ts` |
| POST | `/studio/fixtures/activate` | Activate a fixture for a route | `fixtures.ts` |
| GET | `/studio/fixtures/active` | Get all active fixtures | `fixtures.ts` |

### 1.9 Orchestrator Endpoints (dev loop management)

| Method | Path | Description | Handler |
|--------|------|-------------|---------|
| GET | `/orchestrator/status` | `{ process, pid, apiReachable, uptimeMs }` | `orchestrator.ts` |
| POST | `/orchestrator/start` | Spawn dev loop `{ repo, slotCount? }` | `orchestrator.ts` |
| POST | `/orchestrator/stop` | SIGTERM the managed dev loop process | `orchestrator.ts` |
| GET | `/orchestrator/logs` | SSE stream of stdout/stderr ring buffer + live tail | `orchestrator.ts` |

### 1.10 Analytics Proxy Endpoints (forwarded to superfieldApiUrl)

These paths are proxied verbatim to the superfield API server (default: `http://127.0.0.1:7837`).

| Path | Consumer |
|------|----------|
| `GET /analytics/slots` | OrchestratorController, FeaturePaneController |
| `GET /analytics/loops` | OrchestratorController |
| `GET /analytics/check-runs?sha=<sha>` | TurnTimeline component, VisualDiffPanel component |
| `GET /analytics/check-runs/stream` | OrchestratorView (SSE, per-commit CI badge) |
| `POST /steer/escalate` | OrchestratorView (opens escalation with `{ sha, checkRunName }`) |
| `POST /steer/context` | router.ts (via `/studio/steer` proxy) |

### 1.11 Reverse-Proxy Passthrough Paths

| Prefix | Upstream |
|--------|----------|
| `/app/*` | `CONTROL_WEB_SERVICE_HOST:CONTROL_WEB_SERVICE_PORT` (strip `/app`) |
| `/api/*` | `CONTROL_API_SERVICE_HOST:CONTROL_API_SERVICE_PORT` (no strip) |
| `/*` | Static assets from `CONTROL_ASSETS_DIR` or embedded map (SPA fallback) |

---

## 2. Operator and Agent CLI Commands

The CLI is implemented in `packages/cli/` (TypeScript) with the entrypoint at
`packages/cli/bin/superfield.ts` and command dispatch in `packages/cli/index.ts`.
A Rust stub exists at `crates/superfield/src/main.rs` + `crates/sf-cli/src/lib.rs`
(stub only, no commands implemented yet).

### Operator Commands

| Command | Signature | Description |
|---------|-----------|-------------|
| `github add` | `github add` | Authenticate and register a repository |
| `github forget` | `github forget` | Remove credentials, print app uninstall link |
| `control` | `control [--port <n>] [--path <dir>] [--api-url <url>]` | Start the studio HTTP server |
| `start` | `start <path> [slotCount]` | Begin all three loops (plan, dev, doc) |
| `plan` | `plan` | Replan: group issues into phases, create scouts, write Plan |
| `feature` | `feature "<request>"` | Evaluate a feature request and create an issue + Plan entry |
| `audit` | `audit --path <dir> [--repo <owner/name>] [--capabilities <id,...>] [--output-dir <dir>] [--no-issues]` | Audit app repo against blueprint capabilities |
| `deploy` | `deploy [--path <dir>] [--provision] [target]` | Provision and deploy a target |
| `deploy gcp` | `deploy gcp [--project <id>] [--region <r>] [--zone <z>] [--provision] [--image-tag <tag>]` | Provision/deploy to GCP |
| `deploy gcp --login` | `deploy gcp --login [--client-id <id>]` | Google Cloud device-code OAuth |
| `deploy gcp --logout` | `deploy gcp --logout` | Delete local GCP OAuth token |
| `setup-github` | `setup-github --deploy-key --env <e> --repo <owner/name>` | Register per-env SSH deploy key |
| `setup-github` | `setup-github --secrets --env <e> --repo <owner/name> --host <h> --database-url <u>` | Push per-env Actions secrets |
| `sync` | `sync --repo <owner/name> --app-name <name> [--image-repo <r>] [--deployments <a,b,c>]` | Render and PR GitHub Actions workflow templates |
| `deploy-env` | `deploy-env --repo <owner/name> --env <e> --tag <t> --app-name <name> [--workers <a,b,c>] [--health-path <p>] [--namespace <ns>] [--dry-run] [--json]` | Drive rolling update on provisioned VM |
| `rollback-env` | `rollback-env --repo <owner/name> --env <e> --app-name <name> [--workers <a,b,c>] [--health-path <p>] [--namespace <ns>] [--json]` | Roll deployments back to previous revision |
| `doctor` | `doctor --env <e> --repo <owner/name> [--json]` | Run preflight checks (gh-auth, ghcr-pull, secrets, ssh, k3s, db) |
| `init` | `init --env <e> --provider <gcp\|aws\|digitalocean\|vultr> --repo <owner/name> --image-tag <t> [--managed-db] [--region <r>] [--from-step <n>]` | One-shot env init: provision, bootstrap, deploy-key, secrets, sync, deploy |
| `destroy` | `destroy --env <e> --provider <gcp\|aws\|digitalocean\|vultr> --repo <owner/name> [--yes] [--yes-i-really-mean-it]` | Tear down provider infrastructure for an env |
| `export-db` | `export-db --env <e> --out <path> [--repo <owner/name>] [--provider <p>]` | Export database for an env |
| `ci run` | `ci run <workflow> [--vm]` | Run CI workflow locally (Docker or Firecracker VM) |
| `ci snapshot build` | `ci snapshot build --tag <tag> --rootfs <path> [--binary <path>] [--kernel <path>]` | Build Firecracker VM snapshot |
| `ci snapshot restore` | `ci snapshot restore <dir> [--workspace <dir>]` | Restore a saved snapshot |

### Agent Commands (invoked by the dev loop, not operators directly)

| Endpoint / Path | Description |
|-----------------|-------------|
| `POST /steer/context` | Steer a running agent session with additional context (via `/studio/steer` proxy) |
| `POST /steer/escalate` | Escalate a failing check-run to the agent |
| `POST /studio/conformance` | Agent posts blueprint conformance results |
| `POST /studio/issues` | Dev loop registers in-progress issues |
| `PATCH /studio/issues/:number` | Dev loop updates issue status |

---

## 3. Contract-Preservation Notes for the Rust Port

1. **Auth cookie shape** — the JWT cookie is named `studio_session` and carries `{ sub: username }`. The Rust serving backend must set and verify the same cookie name and HMAC-HS256 signature.
2. **Error envelope** — all failure responses use `{ ok: false, error: { code, message, hint } }`. The `fetchJson` wrapper in the browser detects this shape; the Rust backend must emit it for the browser to surface typed errors.
3. **SSE event names** — `done` and `error` named events on rebuild, rollback, and migration-log streams are parsed by event listeners. The Rust port must preserve these event names.
4. **WebSocket path** — the browser opens `ws[s]://…/studio/ws`; the control-ws handler dispatches steer/chat messages via that single path.
5. **Analytics proxy prefix** — `/analytics/*` is forwarded verbatim to the superfield API server (no path stripping). The Rust serving layer must replicate this transparent proxy.
6. **App/API proxy** — `/app/*` strips the `/app` prefix before upstream; `/api/*` does not strip. Both must be preserved.
7. **Static asset SPA fallback** — any `GET /*` path not found on disk must fall back to `index.html` (client-side routing).
8. **CORS** — `getCorsHeaders` emits permissive CORS on studio routes; the Rust backend must replicate for local dev scenarios.
9. **Orchestrator singleton** — the browser expects `/orchestrator/status` to reflect process state across multiple connections; the Rust backend must maintain the same singleton lifecycle.
10. **Issue DB path** — `resolveIssueDbPath()` resolves to `<projectRoot>/.studio/issues.sqlite`. The Rust port of the issues endpoints must use the same path convention.

---

## 4. Source File Map

| Area | TypeScript source | Rust stub |
|------|------------------|-----------|
| CLI entrypoint | `packages/cli/bin/superfield.ts` | `crates/superfield/src/main.rs` |
| CLI commands | `packages/cli/commands/*.ts` | `crates/sf-cli/src/lib.rs` (stub) |
| Control server entrypoint | `packages/control/src/index.ts` | `crates/sf-serve/` (stub) |
| Router | `packages/control/src/router.ts` | — |
| Auth | `packages/control/src/auth.ts` | `crates/sf-auth/` (stub) |
| Orchestrator | `packages/control/src/orchestrator.ts` | — |
| Deploy endpoints | `packages/control/src/deploy.ts` | — |
| Studio chat/steer | `packages/control/src/api.ts`, `control-ws.ts`, `claude-session.ts` | — |
| Analytics proxy | `packages/control/src/router.ts` (inline) | — |
| Issues CRUD | `packages/control/src/api.ts` (handleIssueRequest) | — |
| Browser UI controllers | `packages/control/apps/src/controllers/*.ts` | n/a |
