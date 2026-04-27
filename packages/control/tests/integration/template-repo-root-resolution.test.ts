/**
 * Integration test: SUPERFIELD_REPO_ROOT governs repo-aware code paths in
 * @superfield/control regardless of process.cwd().
 *
 * Proves the control server is cwd-independent: the studio routes resolve the
 * repo root from the environment variable (frozen at module import via
 * agent.ts's REPO_ROOT constant), so changing process.cwd() mid-flight has no
 * effect on responses.
 *
 * Spec: cli/docs/control-template-integration.md §2.2 #9.
 *
 * Strategy:
 *   1. Create a tmp dir to act as the "real" repo root, drop a .studio file
 *      with known sessionId/branch values inside.
 *   2. Set SUPERFIELD_REPO_ROOT to that tmp dir, then `vi.resetModules()` and
 *      dynamic-import the router so agent.ts's REPO_ROOT freezes against the
 *      tmp dir (rather than whatever cwd the previous test files saw).
 *   3. process.chdir() to os.tmpdir() — a deliberately wrong cwd.
 *   4. Hit GET /studio/status with an auth cookie. Assert active=true and that
 *      the response carries the sessionId/branch from the .studio file at
 *      SUPERFIELD_REPO_ROOT (NOT the cwd).
 *   5. Mid-test, chdir to another unrelated tmp dir and repeat the request.
 *      Assert the response payload is unchanged — proving the handler reads
 *      from the env-rooted REPO_ROOT, not cwd.
 *
 * Note on Bun.spawn: tests/helpers/bun-shim.ts replaces Bun.spawn with a stub
 * that yields empty stdout, so getCurrentBranch()/getSessionCommits() return
 * empty values inside vitest. The cwd-independence proof rides on the
 * .studio-file-driven sessionId/branch fields (read with readFileSync from
 * REPO_ROOT), which do exercise the path resolution under test.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ControlConfig } from "../../src/config";

// ── Helpers (mirror studio-server.test.ts) ────────────────────────────────────

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
  routeFn: (req: Request, config: ControlConfig) => Promise<Response>,
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
    const webRes = await routeFn(webReq, config);
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

describe("template repo-root resolution — SUPERFIELD_REPO_ROOT vs cwd", () => {
  let routerServer: Server;
  let baseUrl: string;
  let repoRootDir: string;
  let wrongCwdDirA: string;
  let wrongCwdDirB: string;
  const originalCwd = process.cwd();
  const prevRepoRoot = process.env.SUPERFIELD_REPO_ROOT;
  const SESSION_ID = "envroot42";
  const BRANCH = "studio/env-root-test";

  let authCookie = "";

  beforeAll(async () => {
    // Create a tmp dir to act as SUPERFIELD_REPO_ROOT, plus two unrelated
    // "wrong cwd" tmp dirs to chdir into mid-test.
    repoRootDir = mkdtempSync(join(tmpdir(), "control-reporoot-"));
    wrongCwdDirA = mkdtempSync(join(tmpdir(), "control-wrongcwd-a-"));
    wrongCwdDirB = mkdtempSync(join(tmpdir(), "control-wrongcwd-b-"));

    // Drop a .studio file at the env-rooted dir with known marker values.
    writeFileSync(
      join(repoRootDir, ".studio"),
      JSON.stringify({
        sessionId: SESSION_ID,
        branch: BRANCH,
        startedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    // Move cwd somewhere deliberately wrong BEFORE loading the modules so
    // that any code paths that mistakenly fall back to process.cwd() would
    // pick up wrongCwdDirA, not repoRootDir.
    process.chdir(wrongCwdDirA);

    // Point the env var at the real repo root.
    process.env.SUPERFIELD_REPO_ROOT = repoRootDir;

    // Reset module graph so that agent.ts re-evaluates REPO_ROOT against the
    // env we just set, regardless of what other test files in the same fork
    // already imported.
    vi.resetModules();
    const routerMod = (await import("../../src/router")) as {
      route: (req: Request, config: ControlConfig) => Promise<Response>;
    };

    ({ baseUrl, server: routerServer } = await startRouterServer(
      routerMod.route,
      makeConfig(),
    ));

    // Register a user so we can hit the auth-gated /studio/* routes.
    const username = `reporoot_${Date.now()}`;
    const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "testpass123" }),
    });
    expect(registerRes.status).toBe(201);
    const setCookie = registerRes.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    authCookie = setCookie!.split(";")[0].trim();
    expect(authCookie).toContain("superfield_auth=");
  });

  afterAll(async () => {
    await stopServer(routerServer);
    process.chdir(originalCwd);
    if (prevRepoRoot === undefined) {
      delete process.env.SUPERFIELD_REPO_ROOT;
    } else {
      process.env.SUPERFIELD_REPO_ROOT = prevRepoRoot;
    }
    rmSync(repoRootDir, { recursive: true, force: true });
    rmSync(wrongCwdDirA, { recursive: true, force: true });
    rmSync(wrongCwdDirB, { recursive: true, force: true });
  });

  it("GET /studio/status reads .studio from SUPERFIELD_REPO_ROOT (cwd is unrelated)", async () => {
    expect(process.cwd()).toBe(wrongCwdDirA);
    expect(process.cwd()).not.toBe(repoRootDir);

    const res = await fetch(`${baseUrl}/studio/status`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const firstBodyText = await res.text();
    const body = JSON.parse(firstBodyText) as {
      active?: boolean;
      sessionId?: string;
      branch?: string;
    };

    // active=true proves existsSync(REPO_ROOT/.studio) used the env var, not
    // cwd (wrongCwdDirA has no .studio file). sessionId comes straight from
    // the .studio file at SUPERFIELD_REPO_ROOT, so its presence proves
    // readFileSync(join(REPO_ROOT, '.studio')) resolved against the env var.
    //
    // NOTE: response.branch is overwritten by getCurrentBranch() (live git),
    // which is shimmed to "" in the vitest Bun.spawn stub — so we assert on
    // sessionId rather than branch for the .studio-derived value.
    expect(body.active).toBe(true);
    expect(body.sessionId).toBe(SESSION_ID);

    // Stash for the second test so we can compare exactly.
    (globalThis as Record<string, unknown>).__firstBody = firstBodyText;
  });

  it("response is unchanged after process.chdir() to a different tmp dir", async () => {
    // Move cwd to yet another wrong place mid-test.
    process.chdir(wrongCwdDirB);
    expect(process.cwd()).toBe(wrongCwdDirB);
    expect(process.cwd()).not.toBe(repoRootDir);

    const res = await fetch(`${baseUrl}/studio/status`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const secondBodyText = await res.text();
    const body = JSON.parse(secondBodyText) as {
      active?: boolean;
      sessionId?: string;
    };

    // Identical payload to the first request: env-var-driven, not cwd-driven.
    expect(body.active).toBe(true);
    expect(body.sessionId).toBe(SESSION_ID);

    const firstBodyText = (globalThis as Record<string, unknown>)
      .__firstBody as string;
    expect(secondBodyText).toBe(firstBodyText);
  });
});
