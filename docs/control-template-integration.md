> **STATUS: SUPERSEDED** — the Node/Bun `@superfield/control` backend this
> document specified was retired in the #452 Rust `sf-serve` cutover. The
> studio server is now served entirely by the `sf-serve` Rust binary
> (`crates/sf-serve`); `superfield control` builds the browser UI and delegates
> all serving to it. See [`docs/architecture.md`](architecture.md) (§HTTP
> Routes) and `crates/sf-serve` for the current design. The historical
> Node-server startup contract, `config.ts`/`deploy.ts`/`agent.ts` consumer map,
> the `CONTROL_WEB_SERVICE_NAME` "Option A" decision (never implemented), and
> the 12-test `node:http` + MSW plan below are retained only for context and no
> longer describe the shipped system.

# `superfield control` ↔ `./template` Integration

Status: superseded (see banner) — the sections below are a point-in-time record
of the retired Node/Bun control backend.

## Current behavior (`superfield control`)

`superfield control` is defined in `packages/cli/commands/control.ts`. It no
longer starts a Node/Bun backend. Instead it:

```
superfield control [--port <n>] [--path <path>] [--api-url <url>]
```

1. Builds the browser UI locally (Vite, via `bun run build` in
   `packages/control/apps`).
2. Spawns the `sf-serve` Rust binary (override with `SF_SERVE_BIN`), passing
   `CONTROL_PORT`, `CONTROL_ASSETS_DIR` (the built UI bundle),
   `SUPERFIELD_API_URL`, and — when `--path` is given — `SUPERFIELD_REPO_ROOT`
   and `CONTROL_SOURCE_DIR`.
3. `sf-serve` owns the HTTP server, WebSocket, static asset serving, studio
   routes, and API endpoints. No Node/Bun backend process is started.

Notable changes from the retired spec below:

- `--repo` is now `--path` (still maps to `SUPERFIELD_REPO_ROOT`).
- There is no `controlCommand` → `_startControl` Node server; the injectable
  seam is `_startSfServe`, which spawns the Rust binary.
- `loadConfig()` / `discoverServicePort(..., "web")` and the `config.ts`
  k8s-manifest discovery no longer exist in the control command; manifest
  parsing that remains lives in `packages/control-core/manifest-parser.ts`.
- The studio HTTP contract is owned by `crates/sf-serve` (see
  `crates/sf-serve/src/routes/studio.rs`), not the endpoint table below.

The route/test material that previously appeared here targeted the retired
`node:http` + MSW surface and is not maintained. For studio route coverage,
test `crates/sf-serve` directly.

---

## Historical record (retired Node/Bun control backend)

_Everything below described the retired `@superfield/control` server and is kept
only for historical context. It does not reflect the shipped `sf-serve`
system; do not implement against it._

The retired design booted a Node/Bun studio server from
`packages/cli/commands/control.ts` that imported `@superfield/control`
(`packages/control/`), set `SUPERFIELD_REPO_ROOT` from a `--repo` flag,
discovered a `web` Service port from `<repo>/k8s/` via `discoverServicePort`,
reverse-proxied `/app/*` and `/api/*`, and served studio endpoints
(`/studio/status`, `/studio/timeline`, `/studio/commits`, `/studio/chat`,
`/studio/chat/stream`, `/studio/cluster/events`) with JWT auth. Its test plan
proposed 12 unit/integration/e2e tests under `packages/control/tests/` using
`node:http` and MSW v2 against the `./template` fixture. None of that surface
survives the #452 cutover.
