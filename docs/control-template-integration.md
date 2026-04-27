# `superfield control` ↔ `./template` Integration

Status: spec / not-yet-tested
Scope: defines the contract between the `cli` package's `control` subcommand
(`cli/packages/cli/commands/control.ts`, served by `@superfield/control` in
`cli/packages/control/`) and a real superfield project rooted at `./template`.

The goal: a developer cloned into `./template` can run

```
superfield control --repo /abs/path/to/template
```

and get a working studio server that correctly discovers, proxies, and operates
on the template app.

---

## 1. Expected behavior

### 1.1 Startup contract

Given `--repo <path>` pointing at `./template`:

1. `controlCommand` sets `SUPERFIELD_REPO_ROOT=<path>` before importing
   `@superfield/control` (already implemented in `control.ts:122-124`).
2. `loadConfig()` reads `<path>/k8s/` to discover the `web` Service port via
   `discoverServicePort` and uses it for the `/app/*` proxy target.
   - For `./template`, this must successfully parse `template/k8s/app.yaml`
     and produce a non-default `webPort` (i.e. not the `80` fallback) when a
     `web` Service is declared.
   - If `web` cannot be discovered, `webPort` falls back to `80` and the
     server still starts. A verbose-mode log line must record the fallback.
3. The dev-loop API health-check (`<apiUrl>/health`) is best-effort: failure
   logs a warning (`control.ts:142-146`) but does not abort startup.
4. The HTTP server binds on `CONTROL_PORT` (default `7000`) and accepts
   requests immediately.

### 1.1.1 Known spec gap — Service naming

`config.ts:71` calls `discoverServicePort(join(appRoot, "k8s"), "web")` with the
literal name `"web"`. The shipped `./template` declares only one Service,
`superfield-app` (`template/k8s/app.yaml:98`, port `80`). Today this means:

- Discovery returns `null`, `webPort` falls back to `80`, which happens to
  match the template's actual Service port — so behavior is correct by
  coincidence, not by design.
- Any template whose Service is not on port `80` would silently mis-proxy.

**Decision: Option A** — make the lookup configurable via
`CONTROL_WEB_SERVICE_NAME` (default `"web"`). Rationale:

- Avoids forcing every superfield template to rename its primary Service.
- Keeps the existing default working for any project that already declares
  a `web` Service.
- One-line change in `config.ts`; templates that need a different name
  (like `./template` → `superfield-app`) set the env var.

Implementation note: `cli/packages/control/src/config.ts:71` should read
`process.env.CONTROL_WEB_SERVICE_NAME ?? "web"` and pass that to
`discoverServicePort`. Add the variable to the table at the top of
`config.ts` and mention it in §1.1 of this doc once implemented.

The discovery test (§2.2 #4) sets `CONTROL_WEB_SERVICE_NAME=superfield-app`
and asserts `webPort === 80`.

### 1.2 Repo-root awareness

Every code path in `@superfield/control` that depends on the repo root must
resolve relative to `SUPERFIELD_REPO_ROOT` once it is set, with no hardcoded
parent-of-cwd assumptions. Confirmed consumers (from `grep`):

- `src/deploy.ts`, `src/agent.ts`, `src/helpers.ts`,
  `src/design-mode-context.ts`, `src/claude-session.ts`
- `src/config.ts` (k8s manifest discovery)

Behavior to preserve:

- `cwd` at invocation time is irrelevant — passing `--repo /path/to/template`
  from any working directory yields identical behavior.
- Paths read by the control server (logs, checkpoints, blueprint, k8s) are all
  resolved as `join(SUPERFIELD_REPO_ROOT, …)`.

### 1.3 Endpoints that must work against `./template`

These are the user-visible guarantees, expressed against the template repo:

| Endpoint | Expected behavior with `--repo ./template` |
|---|---|
| `GET /studio/status` (auth) | 200, returns studio mode flag |
| `GET /studio/timeline` (auth) | 200, returns checkpoints from template's git history |
| `GET /studio/commits` (auth) | 200, returns recent commits from template |
| `POST /studio/chat` (auth) | proxies turn to `SUPERFIELD_API_URL`; 502 with structured envelope when API is down |
| `GET /studio/chat/stream` | SSE opens; closes cleanly when no session active |
| `GET /studio/cluster/events` | SSE opens; emits `unknown` health when no cluster |
| `GET /app/*` | reverse-proxies to discovered web service; 502 envelope when unreachable |
| `GET /api/*` | reverse-proxies to api service; 502 envelope when unreachable |
| `GET /` | serves placeholder HTML when `CONTROL_ASSETS_DIR` unset; serves SPA when set |
| `POST /api/auth/register`, `POST /api/auth/login` | issue JWT cookie |

### 1.4 Failure modes that must be graceful

- Dev-loop API down → warn + continue.
- Web/api ClusterIP services unreachable → 502 with the `lib/error-envelope`
  shape; no crash, no hang.
- `template/k8s/app.yaml` malformed or missing `web` Service → fall back to
  port `80`, log via `vlog`, do not throw.
- `--repo` pointing at a non-existent path → server still starts; first
  endpoint that touches the filesystem returns a structured 500 envelope.

### 1.5 Out of scope (explicit non-goals for this milestone)

- Starting a dev loop (`superfield start`) — control only health-checks the
  API URL.
- Building or deploying the template app's images.
- Running the template's own Plan-driven agent commands.

---

## 2. Tests we need to create

All tests live under `cli/packages/control/tests/`. No mocks (per
template/CLAUDE.md "Testing Standards"); use real `node:http` for local
endpoints and MSW v2 for any external HTTP. The `./template` directory is
the fixture — point `SUPERFIELD_REPO_ROOT` at it.

### 2.1 Unit — `tests/unit/`

1. `control-args.test.ts` — `parseControlArgs` covers `--repo`, `--repo=…`,
   `--port`, `--port=…`, `--api-url`, `--api-url=…`, `-h/--help`, unknowns,
   and NaN-port rejection.
2. `control-env-application.test.ts` — calling `controlCommand` with
   `_startControl` injected sets `SUPERFIELD_REPO_ROOT`, `CONTROL_PORT`, and
   `SUPERFIELD_API_URL` before `_startControl` runs.
3. `control-health-warn.test.ts` — `_fetch` rejecting / returning non-OK
   triggers a warn line; `_startControl` still runs.

### 2.2 Integration — `tests/integration/`

Each test sets `SUPERFIELD_REPO_ROOT=$REPO/template` (resolve from the
workspace root), starts a real `@superfield/control` server on an ephemeral
port, and tears it down in `afterAll`.

4. `template-config-discovery.test.ts` — `loadConfig()` against
   `./template` discovers a `web` Service port from
   `template/k8s/app.yaml` (assert: not the default `80`, matches the YAML
   value parsed manually as a sanity check).
5. `template-config-fallback.test.ts` — when `template/k8s/` is temporarily
   shadowed (e.g. point `SUPERFIELD_REPO_ROOT` at a tmp dir with no `k8s/`),
   `webPort` falls back to `80` and no exception is thrown.
6. `template-server-boot.test.ts` — full `controlCommand` invocation against
   `./template` with an injected dead `--api-url`: warns, binds the port,
   and `GET /` returns 200 with placeholder HTML.
7. `template-routes-no-cluster.test.ts` — with no upstream web/api services
   running:
   - `GET /app/anything` → 502 with error envelope
   - `GET /api/anything` → 502 with error envelope
   - `GET /studio/cluster/events` → SSE handshake succeeds, first event has
     status `unknown`, then close.
8. `template-auth-roundtrip.test.ts` — register → login → cookie set; an
   authenticated `GET /studio/status` returns 200 and an unauthenticated
   call returns 401.
9. `template-repo-root-resolution.test.ts` — invoke `superfield control
   --repo <abs path to ./template>` from a `cwd` that is NOT the template:
   any endpoint that touches the repo (e.g. `/studio/timeline`) operates on
   the template's git history, not on the cwd.
10. `template-malformed-k8s.test.ts` — point at a tmp copy of `./template`
    with a deliberately broken `k8s/app.yaml`; server still starts, vlog
    records the fallback, `GET /` returns 200.

### 2.3 E2E — `tests/e2e/specs/`

11. `template-control-smoke.spec.ts` (Playwright) — boot `superfield control
    --repo ./template` against an ephemeral port with `CONTROL_ASSETS_DIR`
    set to a built UI bundle; load `/`, register a user, hit `/studio/status`
    via the UI, and assert the page renders without console errors.

### 2.4 CLI surface — `cli/packages/cli/tests/`

12. `control-command-template.test.ts` — invoke `superfield control --help`
    and assert the usage text matches `controlUsage()`. Invoke with
    `--repo ./template --api-url http://127.0.0.1:1` and `_startControl`
    spy injected; assert env vars applied and `_startControl` called once.

---

## 3. Acceptance

The integration is considered "working" when:

- All 12 tests above pass in CI.
- Running `superfield control --repo $(pwd)/template` from the repo root
  produces a server reachable at `http://127.0.0.1:7000` that survives the
  failure modes in §1.4 without crashing.
- `template/k8s/app.yaml` port changes are picked up automatically on
  control restart (no code change in `cli/` required).
