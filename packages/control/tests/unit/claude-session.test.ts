/**
 * Unit tests for studio/apps/server/src/claude-session.ts
 *
 * Issue #166 test plan items covered:
 *   - Unit test: JSONL log entry contains all required fields
 *   - Unit test: streamTurn posts the prompt without a synthetic session key
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── appendTurnLog ─────────────────────────────────────────────────────────────

describe("appendTurnLog", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `claude-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it("creates the log directory if it does not exist", async () => {
    const { appendTurnLog } = await import("../../src/claude-session");
    const nestedDir = join(tmpDir, "nested", "logs");
    const entry = {
      timestamp: new Date().toISOString(),
      message: "hello",
      response: "world",
      filesChanged: [],
      servicesRestarted: [],
      restartDurationMs: 0,
    };
    // Should not throw even though nestedDir does not exist yet.
    expect(() => appendTurnLog(entry, nestedDir)).not.toThrow();
  });

  it("appends a valid JSON line to YYYY-MM-DD.jsonl", async () => {
    const { appendTurnLog } = await import("../../src/claude-session");
    const entry = {
      timestamp: "2026-03-24T05:00:00.000Z",
      message: "make the header blue",
      response: "Done — I updated the header color to blue.",
      filesChanged: ["apps/web/src/components/Header.tsx"],
      servicesRestarted: ["web"],
      restartDurationMs: 1234,
    };
    appendTurnLog(entry, tmpDir);

    // The date in the entry is 2026-03-24.
    const date = entry.timestamp.slice(0, 10);
    const filePath = join(tmpDir, `${date}.jsonl`);
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content.trim()) as typeof entry;

    expect(parsed.timestamp).toBe(entry.timestamp);
    expect(parsed.message).toBe(entry.message);
    expect(parsed.response).toBe(entry.response);
    expect(parsed.filesChanged).toEqual(entry.filesChanged);
    expect(parsed.servicesRestarted).toEqual(entry.servicesRestarted);
    expect(parsed.restartDurationMs).toBe(entry.restartDurationMs);
  });

  it("log entry contains all required fields", async () => {
    const { appendTurnLog } = await import("../../src/claude-session");
    const entry = {
      timestamp: new Date().toISOString(),
      message: "test message",
      response: "test response",
      filesChanged: ["apps/server/src/api.ts"],
      servicesRestarted: ["api"],
      restartDurationMs: 500,
    };
    appendTurnLog(entry, tmpDir);

    const date = entry.timestamp.slice(0, 10);
    const filePath = join(tmpDir, `${date}.jsonl`);
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content.trim()) as Record<string, unknown>;

    // All required fields per spec:
    expect(parsed).toHaveProperty("timestamp");
    expect(parsed).toHaveProperty("message");
    expect(parsed).toHaveProperty("response");
    expect(parsed).toHaveProperty("filesChanged");
    expect(parsed).toHaveProperty("servicesRestarted");
    expect(parsed).toHaveProperty("restartDurationMs");
  });

  it("appends multiple entries as separate lines", async () => {
    const { appendTurnLog } = await import("../../src/claude-session");
    const makeEntry = (msg: string) => ({
      timestamp: new Date().toISOString(),
      message: msg,
      response: `response to ${msg}`,
      filesChanged: [] as string[],
      servicesRestarted: [] as string[],
      restartDurationMs: 0,
    });

    appendTurnLog(makeEntry("turn one"), tmpDir);
    appendTurnLog(makeEntry("turn two"), tmpDir);
    appendTurnLog(makeEntry("turn three"), tmpDir);

    const date = new Date().toISOString().slice(0, 10);
    const filePath = join(tmpDir, `${date}.jsonl`);
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);

    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries[0]!.message).toBe("turn one");
    expect(entries[1]!.message).toBe("turn two");
    expect(entries[2]!.message).toBe("turn three");
  });
});

// ── streamTurn ────────────────────────────────────────────────────────────────

describe("streamTurn", () => {
  it("posts without a synthetic session key", async () => {
    const streamTmpDir = join(
      tmpdir(),
      `claude-session-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(streamTmpDir, { recursive: true });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        'event: session\ndata: {"sessionId":"abc"}\n\ndata: ok\n\nevent: done\ndata: {"filesChanged":[]}\n\n',
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );
    const { streamTurn } = await import("../../src/claude-session");
    const stream = streamTurn(
      "hello world",
      streamTmpDir,
      "design",
      fetchSpy as unknown as typeof fetch,
    );
    await new Response(stream).text();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.message).toBe("hello world");
    expect(body).not.toHaveProperty("sessionKey");
    rmSync(streamTmpDir, { recursive: true, force: true });
  });
});

// ── detectAffectedServices ────────────────────────────────────────────────────

describe("detectAffectedServices", () => {
  it("maps apps/server files to the api service", async () => {
    const { detectAffectedServices } = await import("../../src/claude-session");
    expect(detectAffectedServices(["apps/server/src/api.ts"])).toContain("api");
  });

  it("maps apps/worker files to the agents service", async () => {
    const { detectAffectedServices } = await import("../../src/claude-session");
    expect(detectAffectedServices(["apps/worker/src/index.ts"])).toContain(
      "agents",
    );
  });

  it("maps apps/web files to the web service", async () => {
    const { detectAffectedServices } = await import("../../src/claude-session");
    expect(detectAffectedServices(["apps/web/src/App.tsx"])).toContain("web");
  });

  it("maps packages files to both api and agents", async () => {
    const { detectAffectedServices } = await import("../../src/claude-session");
    const services = detectAffectedServices(["packages/core/src/index.ts"]);
    expect(services).toContain("api");
    expect(services).toContain("agents");
  });

  it("deduplicates services when multiple files match the same service", async () => {
    const { detectAffectedServices } = await import("../../src/claude-session");
    const services = detectAffectedServices([
      "apps/server/src/api.ts",
      "apps/server/src/index.ts",
    ]);
    expect(services.filter((s) => s === "api")).toHaveLength(1);
  });

  it("returns an empty array for unrecognized file paths", async () => {
    const { detectAffectedServices } = await import("../../src/claude-session");
    expect(
      detectAffectedServices(["scripts/dev-start.ts", "docker-compose.yml"]),
    ).toEqual([]);
  });
});
