/**
 * Integration test: with SUPERFIELD_REPO_ROOT pointing at the template repo
 * and upstream services unreachable, the router returns graceful error
 * envelopes (rather than crashing) for /app and /api routes, and the
 * cluster events SSE stream still emits a valid event.
 *
 * Spec: cli/docs/control-template-integration.md §2.2 #7.
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

// ── Helpers (mirrored from studio-server.test.ts) ─────────────────────────────

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
  // Force-close lingering connections (the cluster-status SSE stream stays
  // open until the poll interval ends), otherwise server.close() waits
  // forever and trips the afterAll timeout.
  server.closeAllConnections();
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
    if (webRes.body) {
      const reader = webRes.body.getReader();
      const pump = async (): Promise<void> => {
        // Stream chunks through to the Node response so SSE works.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      };
      pump().catch(() => res.end());
    } else {
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

// ── Tests ────────────────────────────────────────────────────────────────────

d("template routes — no cluster", () => {
  let routerServer: Server;
  let baseUrl: string;
  let priorRepoRoot: string | undefined;

  beforeAll(async () => {
    priorRepoRoot = process.env.SUPERFIELD_REPO_ROOT;
    process.env.SUPERFIELD_REPO_ROOT = resolveTemplatePath();

    const config = makeConfig({
      webServiceUrl: "http://127.0.0.1:1",
      apiServiceUrl: "http://127.0.0.1:1",
    });
    ({ baseUrl, server: routerServer } = await startRouterServer(config));
  });

  afterAll(async () => {
    await stopServer(routerServer);
    if (priorRepoRoot === undefined) {
      delete process.env.SUPERFIELD_REPO_ROOT;
    } else {
      process.env.SUPERFIELD_REPO_ROOT = priorRepoRoot;
    }
  });

  it("returns a 502 error envelope for /app/* when web upstream is unreachable", async () => {
    const res = await fetch(`${baseUrl}/app/anything`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
    expect(typeof body.error?.code).toBe("string");
    expect(typeof body.error?.message).toBe("string");
  });

  it("returns a 502 error envelope for /api/* when api upstream is unreachable", async () => {
    const res = await fetch(`${baseUrl}/api/anything`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
    expect(typeof body.error?.code).toBe("string");
    expect(typeof body.error?.message).toBe("string");
  });

  it("serves /studio/cluster/events as SSE with a valid first event", async () => {
    const res = await fetch(`${baseUrl}/studio/cluster/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain(
      "text/event-stream",
    );

    // The stream emits a `: connected\n\n` heartbeat first, then the cluster
    // poller's `event: cluster-status\ndata: {"status":"..."}` event. Read up
    // to a small chunk budget until we see the status payload — asserting on
    // only the first chunk would race against the heartbeat.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    try {
      for (let i = 0; i < 8; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value ?? new Uint8Array(), { stream: true });
        if (acc.includes("unknown") || acc.includes("healthy")) break;
      }
      expect(acc.includes("unknown") || acc.includes("healthy")).toBe(true);
    } finally {
      await reader.cancel();
    }
  });
});
