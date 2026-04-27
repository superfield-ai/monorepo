/**
 * Integration tests for studio/src/claude-session.ts
 *
 * Phase 3: streamTurn() now calls POST /studio/run on the superfield API
 * server instead of spawning claude directly. These tests use the
 * startSuperfieldFixture() helper which starts the API server in-process on
 * a random port with the claude stub on PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { route } from "../../src/router";
import type { ControlConfig } from "../../src/config";
import {
  startSuperfieldFixture,
  type SuperfieldFixture,
} from "./helpers/superfield-server";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ControlConfig> = {}): ControlConfig {
  return {
    port: 0,
    logDir: "/tmp/studio-test-logs",
    clusterContext: "default",
    openBrowser: false,
    webServiceUrl: "http://127.0.0.1:1",
    apiServiceUrl: "http://127.0.0.1:1",
    assetsDir: undefined,
    superfieldApiUrl: "http://127.0.0.1:7837",
    ...overrides,
  };
}

/** Read all SSE events from a text/event-stream response body. */
async function collectSseEvents(
  response: Response,
): Promise<Array<{ event?: string; data: string }>> {
  const text = await response.text();
  const events: Array<{ event?: string; data: string }> = [];
  const blocks = text.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    let eventName: string | undefined;
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) eventName = line.slice("event: ".length);
      if (line.startsWith("data: ")) data = line.slice("data: ".length);
    }
    events.push({ event: eventName, data });
  }
  return events;
}

// ── Validation tests (no claude needed) ──────────────────────────────────────

describe("GET /studio/chat/stream — request validation", () => {
  it("returns 400 when the message query parameter is missing", async () => {
    const config = makeConfig();
    const req = new Request("http://localhost:7000/studio/chat/stream");
    const res = await route(req, config);
    expect(res.status).toBe(400);
  });

  it("returns 400 when the message query parameter is blank", async () => {
    const config = makeConfig();
    const req = new Request(
      "http://localhost:7000/studio/chat/stream?message=",
    );
    const res = await route(req, config);
    expect(res.status).toBe(400);
  });
});

// ── SSE streaming tests (need superfield fixture) ─────────────────────────────

describe("GET /studio/chat/stream — SSE streaming via API fixture", () => {
  let tmpDir: string;
  let claudeLogPath: string;
  let fixture: SuperfieldFixture;

  beforeAll(async () => {
    tmpDir = join(
      tmpdir(),
      `studio-sse-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    claudeLogPath = join(tmpDir, "claude.log");
    process.env.CLAUDE_E2E_LOG_PATH = claudeLogPath;

    fixture = await startSuperfieldFixture();
    process.env.SUPERFIELD_API_URL = fixture.apiUrl;
  });

  afterAll(async () => {
    await fixture.stop();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it("returns Content-Type: text/event-stream for a valid message", async () => {
    const config = makeConfig({
      logDir: tmpDir,
      superfieldApiUrl: fixture.apiUrl,
    });
    const req = new Request(
      "http://localhost:7000/studio/chat/stream?message=hello+world",
    );
    const res = await route(req, config);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("streams Claude stdout as SSE data events and ends with a done event", async () => {
    const config = makeConfig({
      logDir: tmpDir,
      superfieldApiUrl: fixture.apiUrl,
    });
    const req = new Request(
      "http://localhost:7000/studio/chat/stream?message=hello+from+test",
    );
    const res = await route(req, config);
    expect(res.status).toBe(200);

    const events = await collectSseEvents(res);

    const dataEvents = events.filter((e) => !e.event);
    expect(dataEvents.length).toBeGreaterThan(0);
    const combined = dataEvents.map((e) => e.data).join("");
    expect(combined).toContain("Mocked Claude response");

    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
  });

  it("writes a JSONL log entry after the turn completes", async () => {
    const config = makeConfig({
      logDir: tmpDir,
      superfieldApiUrl: fixture.apiUrl,
    });
    const req = new Request(
      "http://localhost:7000/studio/chat/stream?message=log+test+message",
    );
    const res = await route(req, config);
    await res.text();

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(tmpDir, `${today}.jsonl`);
    expect(existsSync(logFile)).toBe(true);

    const lines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const entry = JSON.parse(lines[lines.length - 1]!) as Record<
      string,
      unknown
    >;
    expect(entry).toHaveProperty("timestamp");
    expect(entry).toHaveProperty("message");
    expect(entry).toHaveProperty("response");
    expect(entry).toHaveProperty("filesChanged");
    expect(entry).toHaveProperty("servicesRestarted");
    expect(entry).toHaveProperty("restartDurationMs");
    expect(entry.message).toBe("log test message");
  });
});

// ── Claude subprocess flags (via API server) ──────────────────────────────────

describe("Claude subprocess — correct flags via API fixture", () => {
  let tmpDir: string;
  let claudeLogPath: string;
  let fixture: SuperfieldFixture;

  beforeAll(async () => {
    tmpDir = join(
      tmpdir(),
      `studio-flags-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    claudeLogPath = join(tmpDir, "claude-flags.log");
    process.env.CLAUDE_E2E_LOG_PATH = claudeLogPath;

    fixture = await startSuperfieldFixture();
    process.env.SUPERFIELD_API_URL = fixture.apiUrl;
  });

  afterAll(async () => {
    await fixture.stop();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it("invokes the claude stub with --dangerously-skip-permissions via API server", async () => {
    const { streamTurn, SESSION_KEY } =
      await import("../../src/claude-session");
    const stream = streamTurn("test flag check", SESSION_KEY, tmpDir, "design");
    const res = new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
    await res.text();

    expect(existsSync(claudeLogPath)).toBe(true);
    const log = readFileSync(claudeLogPath, "utf8");

    expect(log).toContain("--dangerously-skip-permissions");
    expect(log).toContain("-p");
    expect(log).toContain("test flag check");
  });
});

// ── Post-turn hook — git diff ─────────────────────────────────────────────────

describe("post-turn hook — git diff changed files", () => {
  let tmpDir: string;
  let gitRepoDir: string;

  beforeAll(async () => {
    tmpDir = join(
      tmpdir(),
      `studio-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });

    // Initialise a minimal git repo for testing getChangedFiles.
    gitRepoDir = join(tmpDir, "repo");
    mkdirSync(gitRepoDir, { recursive: true });

    const gitInit = spawnSync("git", ["init", gitRepoDir]);
    expect(gitInit.status).toBe(0);

    spawnSync("git", ["config", "user.name", "Test"], { cwd: gitRepoDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: gitRepoDir,
    });

    // Create an initial commit so HEAD exists.
    writeFileSync(join(gitRepoDir, "README.md"), "# Test\n");
    spawnSync("git", ["add", "README.md"], { cwd: gitRepoDir });
    spawnSync("git", ["commit", "--no-gpg-sign", "-m", "init"], {
      cwd: gitRepoDir,
    });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it("detects files added after the base ref", async () => {
    const { getChangedFiles } = await import("../../src/claude-session");

    // Capture HEAD before adding a file.
    const headProc = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: gitRepoDir,
      stdio: "pipe",
    });
    const baseRef = new TextDecoder().decode(headProc.stdout).trim();

    // Add a new file (untracked = appears in git diff HEAD).
    const newFile = join(gitRepoDir, "apps", "server", "src", "new-module.ts");
    mkdirSync(join(gitRepoDir, "apps", "server", "src"), { recursive: true });
    writeFileSync(newFile, "export const x = 1;\n");

    // Override SUPERFIELD_REPO_ROOT so getChangedFiles uses the test repo.
    const savedRoot = process.env.SUPERFIELD_REPO_ROOT;
    process.env.SUPERFIELD_REPO_ROOT = gitRepoDir;

    try {
      spawnSync("git", ["add", "-A"], { cwd: gitRepoDir });
      const files = await getChangedFiles(baseRef);
      expect(files).toContain("apps/server/src/new-module.ts");
    } finally {
      process.env.SUPERFIELD_REPO_ROOT = savedRoot;
    }
  });
});
