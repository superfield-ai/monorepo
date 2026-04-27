/**
 * Integration test: template auth round-trip against the studio router.
 *
 * Boots the router with SUPERFIELD_REPO_ROOT pointed at the canonical template
 * fixture and exercises the full register → login → authed status → unauthed
 * status flow end-to-end.
 *
 * Spec: cli/docs/control-template-integration.md §2.2 #8.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { route } from "../../src/router";
import type { ControlConfig } from "../../src/config";
import {
  findTemplatePath,
  resolveTemplatePath,
} from "../helpers/template-path";

const d = findTemplatePath() ? describe : describe.skip;

// ── Helpers (mirror studio-server.test.ts) ───────────────────────────────────

function makeConfig(overrides: Partial<ControlConfig> = {}): ControlConfig {
  return {
    port: 0,
    logDir: "/tmp/studio-test-logs",
    clusterContext: "default",
    openBrowser: false,
    webServiceUrl: "http://127.0.0.1:0",
    apiServiceUrl: "http://127.0.0.1:0",
    assetsDir: undefined,
    superfieldApiUrl: "http://127.0.0.1:7837",
    ...overrides,
  };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

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

// ── Test ──────────────────────────────────────────────────────────────────────

/**
 * Note on contract vs. spec:
 *
 * The task spec describes JSON `{ email, password }` and "status 200" for
 * register, but the source of truth in `src/auth.ts` accepts
 * `{ username, password }` and returns 201 on register / 200 on login. Per the
 * task instructions ("adapt to match what the source code actually does — but
 * do not change the source"), this test uses the real contract. The session
 * cookie name is `superfield_auth` (HttpOnly, Path=/, SameSite=Lax).
 */
d("template auth round-trip — studio router", () => {
  let routerServer: Server;
  let baseUrl: string;
  const prevRepoRoot = process.env.SUPERFIELD_REPO_ROOT;

  // Capture the cookie set by /api/auth/register so the authed status test can
  // attach it. Using the spec-named credentials value as the username.
  const creds = { username: "test@example.com", password: "test1234" };
  let registerCookie: string | null = null;

  beforeAll(async () => {
    process.env.SUPERFIELD_REPO_ROOT = resolveTemplatePath();
    ({ baseUrl, server: routerServer } = await startRouterServer(makeConfig()));
  });

  afterAll(async () => {
    await stopServer(routerServer);
    if (prevRepoRoot === undefined) {
      delete process.env.SUPERFIELD_REPO_ROOT;
    } else {
      process.env.SUPERFIELD_REPO_ROOT = prevRepoRoot;
    }
  });

  it("POST /api/auth/register returns 2xx with a Set-Cookie session header", async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(creds),
    });
    // Source returns 201 Created for successful registration.
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain("superfield_auth=");
    registerCookie = setCookie;
  });

  it("POST /api/auth/login returns 200 with a Set-Cookie session header", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(creds),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain("superfield_auth=");
  });

  it("GET /studio/status with the auth cookie returns 200", async () => {
    expect(registerCookie).not.toBeNull();
    // Strip everything after the first `;` to get just `superfield_auth=<jwt>`.
    const cookiePair = registerCookie!.split(";")[0]!.trim();
    const res = await fetch(`${baseUrl}/studio/status`, {
      headers: { Cookie: cookiePair },
    });
    expect(res.status).toBe(200);
  });

  it("GET /studio/status without an auth cookie returns 401", async () => {
    const res = await fetch(`${baseUrl}/studio/status`);
    expect(res.status).toBe(401);
  });
});
