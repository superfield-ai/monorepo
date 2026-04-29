/**
 * @file router.ts
 *
 * HTTP request routing for the Studio Server.
 *
 * Canonical spec: docs/studio-e2e-infrastructure.md — "Studio Server Architecture"
 * and docs/cluster-definition.md — "Startup sequence" sections.
 *
 * ## Complete route table (priority order)
 *
 *   POST /studio/rebuild          → trigger image rebuild + rollout restart
 *   GET  /studio/chat/stream      → SSE: Claude CLI turn stream (one per session)
 *   GET  /studio/cluster/events   → SSE: aggregate cluster health (healthy/unknown)
 *   POST /api/auth/register       → create in-memory user, set JWT cookie
 *   POST /api/auth/login          → verify credentials, set JWT cookie
 *   GET  /studio/status           → is studio mode active? (auth required)
 *   GET  /studio/commits          → session commit log (auth required)
 *   GET  /studio/timeline         → checkpoint timeline (auth required)
 *   POST /studio/rollback         → reset HEAD to prior commit (auth required)
 *   POST /studio/reset            → clear in-memory session messages (auth required)
 *   POST /studio/chat             → send message, run agent, return reply (auth required)
 *   GET  /app/*                   → reverse-proxy to web ClusterIP service (strip /app)
 *   GET  /api/*                   → reverse-proxy to api ClusterIP service
 *   GET  /*                       → serve browser UI static assets (CONTROL_ASSETS_DIR)
 *
 * ## Authentication
 *
 * Routes under /studio/* (except /studio/chat/stream and /studio/cluster/events)
 * are protected by a JWT cookie checked inside handleControlRequest(). The auth routes
 * (/api/auth/register, /api/auth/login) are handled before the auth check.
 *
 * The cluster-events and chat-stream SSE endpoints are deliberately unauthenticated:
 * cluster status is non-sensitive, and the streaming endpoint is session-scoped.
 *
 * ## Proxy behaviour
 *
 * The /app/* and /api/* proxies strip the leading path prefix before forwarding so
 * that upstream services receive paths relative to their own roots:
 *
 *   /app/dashboard   → http://<CONTROL_WEB_SERVICE_HOST>:<CONTROL_WEB_SERVICE_PORT>/dashboard
 *   /api/auth/login  → http://<CONTROL_API_SERVICE_HOST>:<CONTROL_API_SERVICE_PORT>/api/auth/login
 *
 * ## Static asset fallback
 *
 * When CONTROL_ASSETS_DIR is set, GET /* serves files from that directory. Any path
 * that does not map to a physical file falls back to index.html (SPA routing). When
 * CONTROL_ASSETS_DIR is unset, a minimal placeholder HTML is returned so debug runs
 * can start without the browser UI built.
 *
 * ## Integration points
 *
 *   - index.ts passes a loaded ControlConfig to route() on every request.
 *   - CONTROL_ASSETS_DIR env var controls where the browser UI is served from.
 *     Set by Dockerfile (runtime) and docker-entrypoint.sh (E2E test image).
 *   - CONTROL_WEB_SERVICE_HOST / CONTROL_WEB_SERVICE_PORT control the /app/* proxy.
 *   - CONTROL_CLUSTER_CONTEXT controls which kubectl context cluster-status-sse uses.
 *
 * See also: docs/studio-e2e-infrastructure.md for the full E2E test setup.
 */

import { existsSync } from "fs";
import { join } from "path";
import type { ControlConfig } from "./config";
import { vlog } from "./config";
import { handleAuthRequest } from "./auth";
import { handleControlRequest } from "./api";
import { clusterStatusSseResponse } from "./cluster-status-sse";
import { type WsData } from "./control-ws";
import { handleOrchestratorRequest } from "./orchestrator";
import { handleDeployRequest } from "./deploy";
import { handleDemoRequest } from "./demo";
import { handleTurnsRequest } from "./turns";
import { handleDocsRequest } from "./docs";
import { debugEventsSseResponse, logBackendError } from "./debug-events";
import { errorResponse } from "../lib/error-envelope";

import { handleRebuildStart, handleRebuildLog } from "./rebuild";

/** Result of the route() call — either a fully-resolved Response or a signal
 *  that the response is pending an async proxy operation. */
export type RouteResult = Response | Promise<Response>;

/**
 * Reverse-proxy a request to the given upstream base URL.
 *
 * The outgoing URL is constructed by:
 *   1. Stripping `stripPrefix` from the start of `req.url`'s pathname.
 *   2. Prepending `upstreamBase`.
 *   3. Preserving the original query string.
 *
 * All original request headers, method, and body are forwarded verbatim.
 * If the upstream is unreachable a 502 Bad Gateway response is returned.
 */
export async function proxyRequest(
  req: Request,
  url: URL,
  upstreamBase: string,
  stripPrefix: string,
): Promise<Response> {
  const tail = url.pathname.slice(stripPrefix.length) || "/";
  const upstreamUrl = `${upstreamBase}${tail}${url.search}`;

  const proxyHeaders = new Headers(req.headers);
  // Prevent forwarding the original Host header — the upstream will set its own.
  proxyHeaders.delete("host");

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: proxyHeaders,
      body:
        req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });

    // Clone the upstream response so we can add our own headers if needed.
    const resHeaders = new Headers(upstreamRes.headers);

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logBackendError(err, `proxy ${upstreamUrl}`);
    return errorResponse({
      code: "upstream",
      message: `Upstream unreachable: ${upstreamUrl}`,
      hint: `Check the target service is running. Cause: ${message}`,
    });
  }
}

/**
 * Serve a file from the pre-built browser UI static assets directory.
 *
 * Falls back to `index.html` for any path that does not correspond to a file
 * on disk (enabling client-side routing).  Returns a 404 response when the
 * assets directory is not configured or the index itself is missing.
 *
 * @param pathname  The URL pathname from the incoming request.
 * @param assetsDir Absolute path to the compiled browser UI output directory.
 */
export async function serveStaticAsset(
  pathname: string,
  assetsDir: string | undefined,
  embeddedAssets?: ReadonlyMap<string, string>,
): Promise<Response> {
  // Dev override: serve directly from the filesystem when CONTROL_ASSETS_DIR is set.
  if (assetsDir) {
    const relativePath =
      pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    const filePath = join(assetsDir, relativePath);

    if (existsSync(filePath)) {
      return new Response(Bun.file(filePath));
    }

    // SPA fallback.
    const indexPath = join(assetsDir, "index.html");
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath));
    }

    return new Response("Not Found", { status: 404 });
  }

  // Production path: serve from assets embedded in the binary at compile time.
  const map = embeddedAssets ?? new Map<string, string>();
  const key = pathname === "/" ? "/index.html" : pathname;
  const embeddedPath = map.get(key);
  if (embeddedPath) {
    return new Response(Bun.file(embeddedPath));
  }

  // SPA fallback for client-side routes not in the asset map.
  const indexPath = map.get("/index.html");
  if (indexPath) {
    return new Response(Bun.file(indexPath));
  }

  // Fallback placeholder when running from source without a built web app.
  // Keeps GET / healthy so integration tests and health checks always pass.
  return new Response(
    `<!doctype html><html><head><title>Studio Server</title></head><body><p>Studio Server is running. Build the web app to serve the full UI.</p></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } },
  );
}

/**
 * Route an incoming HTTP request to the appropriate handler.
 *
 * Priority order:
 *   1. GET  /studio/chat/stream → SSE stream for a Claude turn
 *   2. POST /studio/rebuild     → trigger rebuildAndRestart() for the cluster
 *   3. /app/*  → proxy to web ClusterIP service
 *   4. /api/*  → proxy to api ClusterIP service
 *   5. /*      → serve static browser UI assets
 *
 * SSE endpoint spec (docs/studio-mode.md — "Claude CLI Integration"):
 *   GET /studio/chat/stream?message=<url-encoded-message>
 *
 *   Streams Claude CLI stdout in real time as Server-Sent Events:
 *     data: <chunk>\n\n          — stdout chunk
 *     event: done\ndata: \n\n   — turn complete
 *     event: error\ndata: ...\n\n — non-zero exit code
 *
 * Rebuild endpoint (docs/cluster-definition.md — "On a code change"):
 *   POST /studio/rebuild
 *
 *   Triggers a full image rebuild from Dockerfile.release and restarts all
 *   deployments. Returns JSON with { ok, message } indicating success or
 *   failure. The rebuild runs synchronously — the response is sent after the
 *   rollout restart completes.
 *
 * @param req    The incoming Bun Request.
 * @param config Studio server configuration (service URLs, assets dir).
 */
export async function route(
  req: Request,
  config: ControlConfig,
  server?: { upgrade: (req: Request, opts: { data: WsData }) => boolean },
): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  // WebSocket upgrade — browser chat via WS instead of SSE.
  if (req.method === "GET" && pathname === "/studio/ws") {
    if (!server) {
      return errorResponse({
        code: "unsupported",
        message: "WebSocket not available",
        hint: "The studio server was started without a Bun server reference.",
      });
    }
    const upgraded = server.upgrade(req, {
      data: {
        superfieldApiUrl: config.superfieldApiUrl,
        logDir: config.logDir,
      } satisfies WsData,
    });
    if (!upgraded) {
      return errorResponse({
        code: "validation",
        message: "WebSocket upgrade failed",
        hint: "The client did not send a valid WebSocket upgrade request.",
      });
    }
    // Bun consumes the request after upgrade; return undefined cast to Response.
    return undefined as unknown as Response;
  }

  // REST steer fallback (for tests, curl, and non-WS clients).
  if (req.method === "POST" && pathname === "/studio/steer") {
    const body = (await req.json().catch(() => ({}))) as {
      context?: string;
      sessionId?: string;
      session_id?: string;
    };
    const sessionId = body.session_id ?? body.sessionId;
    if (!body.context) {
      return errorResponse({
        code: "validation",
        message: "context is required",
        hint: "POST { context: string, sessionId: string } to /studio/steer.",
      });
    }
    if (!sessionId) {
      return errorResponse({
        code: "validation",
        message: "sessionId is required",
        hint: "Select a running issue before steering a live agent session.",
      });
    }
    try {
      const res = await fetch(`${config.superfieldApiUrl}/steer/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: body.context, session_id: sessionId }),
      });
      const json = await res.json().catch(() => ({}));
      return new Response(JSON.stringify(json), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logBackendError(err, "POST /studio/steer");
      return errorResponse({
        code: "upstream",
        message: `Steering API unreachable at ${config.superfieldApiUrl}`,
        hint: `Cause: ${message}. Start the dev loop with POST /orchestrator/start.`,
      });
    }
  }

  // Rebuild endpoint — kicks off a background docker build job and returns
  // a jobId immediately. The caller streams progress from GET /studio/rebuild/log.
  if (req.method === "POST" && pathname === "/studio/rebuild") {
    return handleRebuildStart(req, config);
  }

  if (req.method === "GET" && pathname === "/studio/rebuild/log") {
    return handleRebuildLog(url);
  }

  // SSE stream endpoint for Claude CLI turns.
  // Canonical spec: docs/studio-mode.md — "Claude CLI Integration"
  if (req.method === "GET" && pathname === "/studio/chat/stream") {
    const { streamTurn } = await import("./claude-session");
    const message = url.searchParams.get("message") ?? "";
    if (!message.trim()) {
      return errorResponse({
        code: "validation",
        message: "message query parameter is required",
        hint: "Pass ?message=<text> to /studio/chat/stream.",
      });
    }
    const modeParam = url.searchParams.get("mode");
    const mode =
      modeParam === "question" ? ("question" as const) : ("design" as const);
    const stream = streamTurn(message, config.logDir, mode);
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // SSE stream for backend debug events (errors + warnings).
  // Consumed by the browser DebugStore (apps/src/lib/backend-debug-stream.ts)
  // so a unified browser + backend timeline is available in /studio/debug.
  if (req.method === "GET" && pathname === "/studio/debug/events") {
    return debugEventsSseResponse();
  }

  // SSE stream for aggregate cluster health status.
  // Canonical: apps/server/src/cluster-status-sse.ts
  if (req.method === "GET" && pathname === "/studio/cluster/events") {
    return clusterStatusSseResponse(config.clusterContext);
  }

  // Deploy endpoints — D1 / C-9.5 deployment health view.
  const deployResponse = await handleDeployRequest(req, url);
  if (deployResponse) return deployResponse;

  // Demo content endpoints — D2 / D3 / D6 fixtures from .studio/demo/*.
  const demoResponse = handleDemoRequest(req, url);
  if (demoResponse) return demoResponse;

  // Turn timeline — D6 / C-9.6.
  const turnsResponse = handleTurnsRequest(req, url);
  if (turnsResponse) return turnsResponse;

  // Docs endpoints — Product tab markdown viewer.
  const docsResponse = handleDocsRequest(req, url, config.projectRoot);
  if (docsResponse) return docsResponse;

  // Orchestrator endpoints — manage the dev loop child process.
  const orchResponse = await handleOrchestratorRequest(
    req,
    url,
    config.superfieldApiUrl ?? "http://127.0.0.1:7837",
  );
  if (orchResponse) return orchResponse;

  // Analytics endpoints — proxy to the superfield API server (dev loop).
  // The frontend controllers use /analytics/* directly; the control server
  // must forward them to superfieldApiUrl where the core api-server handles them.
  if (pathname.startsWith("/analytics/")) {
    const apiUrl = config.superfieldApiUrl ?? "http://127.0.0.1:7837";
    vlog(config, `Proxying ${pathname} → ${apiUrl} (analytics)`);
    return proxyRequest(req, url, apiUrl, "");
  }

  // Auth endpoints — handled locally, not proxied upstream.
  const authResponse = await handleAuthRequest(req, url);
  if (authResponse) return authResponse;

  // Studio endpoints — handled locally, not proxied upstream.
  const studioResponse = await handleControlRequest(req, url, config.logDir);
  if (studioResponse) return studioResponse;

  if (pathname.startsWith("/app/") || pathname === "/app") {
    vlog(config, `Proxying ${pathname} → ${config.webServiceUrl} (strip /app)`);
    return proxyRequest(req, url, config.webServiceUrl, "/app");
  }

  if (pathname.startsWith("/api/") || pathname === "/api") {
    vlog(config, `Proxying ${pathname} → ${config.apiServiceUrl} (strip none)`);
    return proxyRequest(req, url, config.apiServiceUrl, "");
  }

  vlog(
    config,
    `Serving static asset: ${pathname} from ${config.assetsDir ?? "(unset)"}`,
  );
  return serveStaticAsset(pathname, config.assetsDir, config.embeddedAssets);
}
