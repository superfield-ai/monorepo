/**
 * Integration tests for the Studio Server.
 *
 * Issue #164 test plan items covered:
 *   - Integration test: server starts and responds to health check
 *   - Integration test: proxy forwards request and returns upstream response
 *
 * These tests spin up a real Node HTTP server bound to a random port so they
 * do not require the cluster services to be running. The upstream web and api
 * services are replaced by lightweight in-test servers that return predictable
 * responses.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server } from "http";
import type { AddressInfo } from "net";
import { route } from "../../src/router";
import type { ControlConfig } from "../../src/config";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ControlConfig> = {}): ControlConfig {
  return {
    port: 0,
    logDir: "/tmp/studio-test-logs",
    clusterContext: "default",
    openBrowser: false,
    webServiceUrl: "http://127.0.0.1:0", // overridden per test
    apiServiceUrl: "http://127.0.0.1:0",
    assetsDir: undefined,
    superfieldApiUrl: "http://127.0.0.1:7837",
    ...overrides,
  };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Start a Node HTTP server that adapts the Web API `route()` function so it
 * can be reached over a real TCP connection.
 */
async function startRouterServer(
  config: ControlConfig,
): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : null;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }

    const webReq = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method ?? "GET",
      headers,
      ...(body ? { body } : {}),
    });
    const webRes = await route(webReq, config);
    const resHeaders: Record<string, string> = {};
    webRes.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    res.writeHead(webRes.status, resHeaders);
    res.end(Buffer.from(await webRes.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

/**
 * Start a lightweight fake HTTP server for upstream service stubs.
 */
async function startFakeServer(
  handler: (req: IncomingMessage) => {
    status: number;
    headers?: Record<string, string>;
    body: string;
  },
): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    const { status, headers = {}, body } = handler(req);
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, server };
}

// ── Studio server health check ────────────────────────────────────────────────

describe("studio server — health check", () => {
  let routerServer: Server;
  let baseUrl: string;
  let config: ControlConfig;

  beforeAll(async () => {
    config = makeConfig();
    ({ baseUrl, server: routerServer } = await startRouterServer(config));
  });

  afterAll(() => stopServer(routerServer));

  it("returns a non-error response on GET /", async () => {
    const res = await fetch(`${baseUrl}/`);
    // Without assetsDir the server returns a placeholder HTML page (200).
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns 502 when the upstream web service is not running", async () => {
    // Port 1 is privileged, always refused → 502.
    config.webServiceUrl = "http://127.0.0.1:1";
    const res = await fetch(`${baseUrl}/app/anything`);
    expect(res.status).toBe(502);
  });
});

// ── Proxy integration — web service ──────────────────────────────────────────

describe("studio server — proxy to web service", () => {
  let routerServer: Server;
  let upstreamServer: Server;
  let studioBaseUrl: string;

  beforeAll(async () => {
    const upstream = await startFakeServer((req) => {
      const url = new URL(req.url!, "http://localhost");
      return {
        status: 200,
        headers: { "X-From": "web-service" },
        body: `web:${url.pathname}`,
      };
    });
    upstreamServer = upstream.server;

    const config = makeConfig({
      webServiceUrl: `http://127.0.0.1:${upstream.port}`,
    });
    ({ baseUrl: studioBaseUrl, server: routerServer } =
      await startRouterServer(config));
  });

  afterAll(async () => {
    await stopServer(routerServer);
    await stopServer(upstreamServer);
  });

  it("forwards GET /app/dashboard to upstream and returns its response", async () => {
    const res = await fetch(`${studioBaseUrl}/app/dashboard`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The upstream echoes the path after stripping /app, so it sees /dashboard.
    expect(body).toBe("web:/dashboard");
  });

  it("forwards query strings to the upstream web service", async () => {
    const res = await fetch(`${studioBaseUrl}/app/search?q=test`);
    expect(res.status).toBe(200);
  });
});

// ── Proxy integration — api service ──────────────────────────────────────────

describe("studio server — proxy to api service", () => {
  let routerServer: Server;
  let upstreamServer: Server;
  let studioBaseUrl: string;

  beforeAll(async () => {
    const upstream = await startFakeServer((req) => {
      const url = new URL(req.url!, "http://localhost");
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: url.pathname }),
      };
    });
    upstreamServer = upstream.server;

    const config = makeConfig({
      apiServiceUrl: `http://127.0.0.1:${upstream.port}`,
    });
    ({ baseUrl: studioBaseUrl, server: routerServer } =
      await startRouterServer(config));
  });

  afterAll(async () => {
    await stopServer(routerServer);
    await stopServer(upstreamServer);
  });

  it("forwards GET /api/healthz to upstream and returns its response", async () => {
    const res = await fetch(`${studioBaseUrl}/api/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe("/api/healthz");
  });

  it("handles POST /api/auth/login locally (returns 401 for unknown credentials)", async () => {
    // Auth routes are intercepted by handleAuthRequest before the proxy, so
    // /api/auth/login is handled in-process rather than forwarded upstream.
    const res = await fetch(`${studioBaseUrl}/api/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "nobody", password: "wrong" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("forwards non-auth GET /api/tasks to upstream and returns its response", async () => {
    const res = await fetch(`${studioBaseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe("/api/tasks");
  });
});
