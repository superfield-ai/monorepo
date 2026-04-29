/**
 * Integration test — malformed k8s manifest fallback.
 *
 * Spec: cli/docs/control-template-integration.md §2.2 #10 and §1.4.
 *
 * Verifies that when SUPERFIELD_REPO_ROOT points at a template copy whose
 * k8s/app.yaml is corrupted (truncated mid-Service definition), loadConfig()
 * does not throw — discovery is best-effort and falls back to webPort=80.
 * The router server still serves GET / with a 200 placeholder HTML page.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ControlConfig } from "../../src/config";
import { route } from "../../src/router";
import {
  findTemplatePath,
  resolveTemplatePath,
} from "../helpers/template-path";

const d = findTemplatePath() ? describe : describe.skip;
const TEST_LOG_DIR = process.env.CONTROL_LOG_DIR ?? "../studio-logs";

// Truncated app.yaml — cut mid-Service definition, leaving spec dangling.
const TRUNCATED_APP_YAML = `# Deployment + Service for the Superfield application container.
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: superfield-app
  labels:
    app: superfield-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: superfield-app
  template:
    metadata:
      labels:
        app: superfield-app
    spec:
      containers:
        - name: app
          image: ghcr.io/<owner>/superfield-starter-ts:latest
          ports:
`;

function makeConfig(overrides: Partial<ControlConfig> = {}): ControlConfig {
  return {
    port: 0,
    logDir: TEST_LOG_DIR,
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
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req as AsyncIterable<Buffer>)
        chunks.push(chunk);
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
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

d("template malformed k8s — loadConfig fallback", () => {
  let tmpDir: string;
  let priorRepoRoot: string | undefined;

  beforeAll(() => {
    priorRepoRoot = process.env.SUPERFIELD_REPO_ROOT;
    tmpDir = mkdtempSync(join(tmpdir(), "sf-malformed-k8s-"));
    const srcK8s = join(resolveTemplatePath(), "k8s");
    const destK8s = join(tmpDir, "k8s");
    cpSync(srcK8s, destK8s, { recursive: true });
    // Overwrite app.yaml with a truncated, mid-Service-definition version.
    writeFileSync(join(destK8s, "app.yaml"), TRUNCATED_APP_YAML);
    process.env.SUPERFIELD_REPO_ROOT = tmpDir;
    // Ensure the explicit override does not mask the fallback path.
    delete process.env.CONTROL_WEB_SERVICE_PORT;
  });

  afterAll(() => {
    if (priorRepoRoot === undefined) {
      delete process.env.SUPERFIELD_REPO_ROOT;
    } else {
      process.env.SUPERFIELD_REPO_ROOT = priorRepoRoot;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadConfig() does not throw and webServiceUrl falls back to :80", () => {
    // Per spec §1.4, manifest discovery is best-effort: a corrupted YAML
    // must be swallowed by the try/catch in config.ts (lines 64-77) and
    // webPort must default to 80.
    let config: ControlConfig | undefined;
    expect(() => {
      config = loadConfig();
    }).not.toThrow();
    expect(config).toBeDefined();
    expect(config!.webServiceUrl.endsWith(":80")).toBe(true);
  });

  it("router server serves GET / with 200 placeholder HTML", async () => {
    const config = makeConfig();
    const { baseUrl, server } = await startRouterServer(config);
    try {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).toContain("text/html");
    } finally {
      await stopServer(server);
    }
  });
});
