/**
 * Unit tests for the POST /studio/run SSE endpoint added in Phase 3.
 *
 * Uses a real HTTP server (same pattern as api-server.test.ts) with the
 * studio claude stub injected into PATH so no real claude is invoked.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { delimiter } from "node:path";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ApiState } from "../../api-state.js";
import { startApiServer } from "../../api-server.js";
import type { Logger } from "../../logger.js";

// Path to the studio claude stub (emits "Mocked Claude response for studio tests.")
const STUB_DIR = new URL(
  "../../../../packages/control/tests/fixtures",
  import.meta.url,
).pathname;

const noopLogger: Logger = { currentLevel: "info", emit: () => {} };

let port: number;
let savedPath: string;
let savedLogPath: string | undefined;
let traceDir: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        port = (probe.address() as AddressInfo).port;
        probe.close(() => {
          traceDir = `/tmp/api-server-studio-run-traces-${Date.now()}`;
          mkdirSync(traceDir, { recursive: true });
          const state = new ApiState();
          const srv = startApiServer({
            port,
            state,
            logger: noopLogger,
            logDir: traceDir,
          });
          srv.once("listening", resolve);
        });
      });
    }),
);

beforeAll(() => {
  savedPath = process.env.PATH ?? "";
  savedLogPath = process.env.CLAUDE_E2E_LOG_PATH;
  process.env.PATH = `${STUB_DIR}${delimiter}${savedPath}`;
  process.env.CLAUDE_E2E_LOG_PATH = "/tmp/api-server-studio-run-test.log";
});

afterAll(() => {
  process.env.PATH = savedPath;
  if (savedLogPath === undefined) {
    delete process.env.CLAUDE_E2E_LOG_PATH;
  } else {
    process.env.CLAUDE_E2E_LOG_PATH = savedLogPath;
  }
  try {
    rmSync(traceDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function postRun(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/studio/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function collectSse(
  res: Response,
): Promise<{ event?: string; data: string }[]> {
  const text = await res.text();
  const events: { event?: string; data: string }[] = [];
  for (const block of text.split("\n\n").filter(Boolean)) {
    let eventName: string | undefined;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: "))
        eventName = line.slice("event: ".length).trim();
      if (line.startsWith("data: ")) data += line.slice("data: ".length);
    }
    if (data) events.push({ event: eventName, data });
  }
  return events;
}

// ── POST /studio/run ──────────────────────────────────────────────────────────

describe("POST /studio/run", () => {
  it("missing message → 400 JSON error", async () => {
    const res = await postRun({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("message is required");
  });

  it("valid message → Content-Type: text/event-stream", async () => {
    const res = await postRun({ message: "hello", repoRoot: "/tmp" });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("first SSE frame is event:session with UUID sessionId", async () => {
    const res = await postRun({ message: "hello", repoRoot: "/tmp" });
    const events = await collectSse(res);
    const sessionEvent = events.find((e) => e.event === "session");
    expect(sessionEvent).toBeDefined();
    const parsed = JSON.parse(sessionEvent!.data) as { sessionId: string };
    expect(parsed.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("stub emits output → at least one data line in SSE body", async () => {
    const res = await postRun({ message: "hello", repoRoot: "/tmp" });
    const events = await collectSse(res);
    const dataEvents = events.filter((e) => !e.event);
    expect(dataEvents.length).toBeGreaterThan(0);
    const combined = dataEvents.map((e) => e.data).join("");
    expect(combined).toContain("Mocked Claude response");
  });

  it("event:done arrives after all data lines", async () => {
    const res = await postRun({ message: "hello", repoRoot: "/tmp" });
    const events = await collectSse(res);
    const doneIdx = events.findIndex((e) => e.event === "done");
    const sessionIdx = events.findIndex((e) => e.event === "session");
    expect(doneIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(sessionIdx);
  });

  it("event:done contains filesChanged array", async () => {
    const res = await postRun({ message: "hello", repoRoot: "/tmp" });
    const events = await collectSse(res);
    const done = events.find((e) => e.event === "done");
    expect(done).toBeDefined();
    const parsed = JSON.parse(done!.data) as { filesChanged: unknown[] };
    expect(Array.isArray(parsed.filesChanged)).toBe(true);
  });

  it("valid message + sessionKey → response is still SSE", async () => {
    const res = await postRun({
      message: "hello",
      repoRoot: "/tmp",
      sessionKey: "key-123",
    });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await res.body?.cancel();

    const today = new Date().toISOString().slice(0, 10);
    const traceFile = join(traceDir, `${today}.traces.jsonl`);
    const entries = readFileSync(traceFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            level: string;
            message: string;
            context?: { args?: string[] };
          },
      );
    const start = entries
      .filter((entry) => entry.message === "POST /studio/run started")
      .at(-1)!;
    expect(start.level).toBe("info");
    expect(start.message).toBe("POST /studio/run started");
    expect(start.context?.args).toContain("--session-id");
    expect(start.context?.args).not.toContain("--session-key");
  });

  it("writes a trace record when claude exits nonzero", async () => {
    process.env.CLAUDE_E2E_EXIT_1 = "1";
    try {
      const res = await postRun({ message: "hello", repoRoot: "/tmp" });
      const events = await collectSse(res);
      const error = events.find((e) => e.event === "error");
      expect(error?.data).toContain("simulated claude failure");

      const today = new Date().toISOString().slice(0, 10);
      const traceFile = join(traceDir, `${today}.traces.jsonl`);
      expect(existsSync(traceFile)).toBe(true);

      const lines = readFileSync(traceFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      const last = JSON.parse(lines.at(-1)!) as {
        level: string;
        message: string;
        context?: { exitCode?: number; stderr?: string };
      };
      expect(last.level).toBe("error");
      expect(last.message).toBe("POST /studio/run failed");
      expect(last.context?.exitCode).toBe(1);
      expect(last.context?.stderr).toContain("simulated claude failure");
    } finally {
      delete process.env.CLAUDE_E2E_EXIT_1;
    }
  });
});
