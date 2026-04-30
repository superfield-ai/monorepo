/**
 * Integration tests for the studio chat pipeline end-to-end.
 *
 * Tests cover:
 *  - Multi-turn session resume: second turn passes --resume to the claude stub
 *  - Reset clears session so the next turn starts fresh (no --resume)
 *  - Realistic multi-line output from golden fixtures flows correctly through
 *    the SSE pipeline (split by lines, forwarded as separate data events)
 *
 * All tests use the superfield fixture server so no real Claude is needed.
 *
 * Note: streamTurn() consumes the `event: session` frame internally and stores
 * the session ID in the SQLite session store (via the API server).  The session
 * ID is NOT re-emitted in the stream returned to callers — it is verified
 * indirectly by inspecting the claude stub's ARGS log for --resume on the
 * second turn.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  startSuperfieldFixture,
  type SuperfieldFixture,
} from "./helpers/superfield-server";
import { streamTurn } from "../../src/claude-session";

// Path to the studio goldens directory (adjacent to the claude stub).
const GOLDENS_DIR = new URL("../fixtures/studio-goldens", import.meta.url)
  .pathname;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Drain a ReadableStream<Uint8Array> and return all SSE events. */
async function collectSse(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<{ event?: string; data: string }>> {
  const text = await new Response(stream).text();
  const events: Array<{ event?: string; data: string }> = [];
  for (const block of text.split("\n\n").filter(Boolean)) {
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

// ── Multi-turn session resume ─────────────────────────────────────────────────

describe("multi-turn session resume", () => {
  let tmpDir: string;
  let claudeLogPath: string;
  let fixture: SuperfieldFixture;
  const FIXED_SESSION_ID = "test-resume-session-abc123";
  let savedControlLogDir: string | undefined;
  let savedSessionId: string | undefined;

  beforeAll(async () => {
    tmpDir = join(
      tmpdir(),
      `studio-multiturn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    claudeLogPath = join(tmpDir, "claude.log");

    // Isolate the session store to this temp directory so tests don't
    // interfere with other suites that share the default log dir.
    savedControlLogDir = process.env.CONTROL_LOG_DIR;
    savedSessionId = process.env.CLAUDE_E2E_SESSION_ID;
    process.env.CONTROL_LOG_DIR = tmpDir;
    process.env.CLAUDE_E2E_LOG_PATH = claudeLogPath;
    process.env.CLAUDE_E2E_SESSION_ID = FIXED_SESSION_ID;

    fixture = await startSuperfieldFixture();
    process.env.SUPERFIELD_API_URL = fixture.apiUrl;
  });

  afterAll(async () => {
    if (savedControlLogDir === undefined) {
      delete process.env.CONTROL_LOG_DIR;
    } else {
      process.env.CONTROL_LOG_DIR = savedControlLogDir;
    }
    if (savedSessionId === undefined) {
      delete process.env.CLAUDE_E2E_SESSION_ID;
    } else {
      process.env.CLAUDE_E2E_SESSION_ID = savedSessionId;
    }
    await fixture.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first turn streams response text and ends with done event", async () => {
    const stream = streamTurn("first message", tmpDir, "design");
    const events = await collectSse(stream);

    const dataEvents = events.filter((e) => !e.event);
    expect(dataEvents.length).toBeGreaterThan(0);
    const combined = dataEvents.map((e) => e.data).join("");
    expect(combined).toContain("Mocked Claude response");

    expect(events.find((e) => e.event === "done")).toBeDefined();
  });

  it("first turn does not include --resume in claude args", async () => {
    // Re-run (the previous test already ran one turn; this verifies the log).
    const log = readFileSync(claudeLogPath, "utf8");
    const firstInvocation = log.split("ARGS:")[1] ?? "";
    expect(firstInvocation).not.toContain("--resume");
  });

  it("second turn includes --resume with the session ID from the first turn", async () => {
    const stream = streamTurn("follow-up message", tmpDir, "design");
    await collectSse(stream);

    const log = readFileSync(claudeLogPath, "utf8");
    const invocations = log.split("ARGS:");
    // invocations[0] = empty prefix, [1] = first call, [2] = second call
    const secondCall = invocations[2] ?? "";
    expect(secondCall).toContain("--resume");
    expect(secondCall).toContain(FIXED_SESSION_ID);
  });
});

// ── Session reset ─────────────────────────────────────────────────────────────

describe("session reset clears resume ID", () => {
  let tmpDir: string;
  let claudeLogPath: string;
  let fixture: SuperfieldFixture;
  const FIXED_SESSION_ID = "test-reset-session-def456";
  let savedControlLogDir: string | undefined;
  let savedSessionId: string | undefined;

  beforeAll(async () => {
    tmpDir = join(
      tmpdir(),
      `studio-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    claudeLogPath = join(tmpDir, "claude-reset.log");

    savedControlLogDir = process.env.CONTROL_LOG_DIR;
    savedSessionId = process.env.CLAUDE_E2E_SESSION_ID;
    process.env.CONTROL_LOG_DIR = tmpDir;
    process.env.CLAUDE_E2E_LOG_PATH = claudeLogPath;
    process.env.CLAUDE_E2E_SESSION_ID = FIXED_SESSION_ID;

    fixture = await startSuperfieldFixture();
    process.env.SUPERFIELD_API_URL = fixture.apiUrl;
  });

  afterAll(async () => {
    if (savedControlLogDir === undefined) {
      delete process.env.CONTROL_LOG_DIR;
    } else {
      process.env.CONTROL_LOG_DIR = savedControlLogDir;
    }
    if (savedSessionId === undefined) {
      delete process.env.CLAUDE_E2E_SESSION_ID;
    } else {
      process.env.CLAUDE_E2E_SESSION_ID = savedSessionId;
    }
    await fixture.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("after POST /studio/reset, next turn does not include --resume", async () => {
    // First turn — stores FIXED_SESSION_ID in the session store.
    const stream1 = streamTurn("first message", tmpDir, "design");
    await collectSse(stream1);

    // Reset via the API server's /studio/reset endpoint.
    const resetRes = await fetch(`${fixture.apiUrl}/studio/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resetRes.ok).toBe(true);

    // Second turn after reset — should NOT have --resume.
    const stream2 = streamTurn("message after reset", tmpDir, "design");
    await collectSse(stream2);

    const log = readFileSync(claudeLogPath, "utf8");
    const invocations = log.split("ARGS:");
    // [1] = first call, [2] = call after reset
    const callAfterReset = invocations[2] ?? "";
    expect(callAfterReset).not.toContain("--resume");
  });
});

// ── Golden fixture — realistic multi-line output ──────────────────────────────

describe("golden fixture — realistic multi-line output", () => {
  let tmpDir: string;
  let fixture: SuperfieldFixture;
  let savedGolden: string | undefined;
  let savedControlLogDir: string | undefined;

  beforeAll(async () => {
    tmpDir = join(
      tmpdir(),
      `studio-golden-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });

    savedGolden = process.env.CLAUDE_STUDIO_GOLDEN;
    savedControlLogDir = process.env.CONTROL_LOG_DIR;
    process.env.CONTROL_LOG_DIR = tmpDir;
    process.env.CLAUDE_E2E_LOG_PATH = join(tmpDir, "claude-golden.log");
    process.env.CLAUDE_STUDIO_GOLDEN = "question";

    fixture = await startSuperfieldFixture();
    process.env.SUPERFIELD_API_URL = fixture.apiUrl;
  });

  afterAll(async () => {
    if (savedGolden === undefined) delete process.env.CLAUDE_STUDIO_GOLDEN;
    else process.env.CLAUDE_STUDIO_GOLDEN = savedGolden;
    if (savedControlLogDir === undefined) delete process.env.CONTROL_LOG_DIR;
    else process.env.CONTROL_LOG_DIR = savedControlLogDir;
    await fixture.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("golden file exists for the question scenario", () => {
    expect(existsSync(join(GOLDENS_DIR, "question.json"))).toBe(true);
  });

  it("multi-line golden response is split into per-line SSE data events", async () => {
    const stream = streamTurn("What is this repo?", tmpDir, "question");
    const events = await collectSse(stream);

    // The golden has multiple paragraphs separated by blank lines which become
    // empty data lines; filter to non-empty data events.
    const dataEvents = events.filter((e) => !e.event && e.data.trim() !== "");
    expect(dataEvents.length).toBeGreaterThan(1);

    const combined = dataEvents.map((e) => e.data).join("\n");
    expect(combined).toContain("Superfield");
  });

  it("golden SSE stream ends with a done event", async () => {
    const stream = streamTurn("Describe this repo", tmpDir, "question");
    const events = await collectSse(stream);

    expect(events.find((e) => e.event === "done")).toBeDefined();
  });

  it("second question-mode golden turn uses --resume with the golden session ID", async () => {
    // First turn stores the golden's session_id in SQLite.
    const stream1 = streamTurn("First question", tmpDir, "question");
    await collectSse(stream1);

    // Second turn should use --resume with the golden's session ID.
    const stream2 = streamTurn("Follow-up question", tmpDir, "question");
    await collectSse(stream2);

    const log = readFileSync(join(tmpDir, "claude-golden.log"), "utf8");
    const invocations = log.split("ARGS:");
    const secondCall = invocations[2] ?? "";
    expect(secondCall).toContain("--resume");
    expect(secondCall).toContain("studio-golden-q-00000000000000001");
  });
});

// ── Golden fixture — design mode ──────────────────────────────────────────────

describe("golden fixture — design mode response", () => {
  let tmpDir: string;
  let fixture: SuperfieldFixture;
  let savedGolden: string | undefined;
  let savedControlLogDir: string | undefined;

  beforeAll(async () => {
    tmpDir = join(
      tmpdir(),
      `studio-golden-design-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });

    savedGolden = process.env.CLAUDE_STUDIO_GOLDEN;
    savedControlLogDir = process.env.CONTROL_LOG_DIR;
    process.env.CONTROL_LOG_DIR = tmpDir;
    process.env.CLAUDE_E2E_LOG_PATH = join(tmpDir, "claude-design.log");
    process.env.CLAUDE_STUDIO_GOLDEN = "design";

    fixture = await startSuperfieldFixture();
    process.env.SUPERFIELD_API_URL = fixture.apiUrl;
  });

  afterAll(async () => {
    if (savedGolden === undefined) delete process.env.CLAUDE_STUDIO_GOLDEN;
    else process.env.CLAUDE_STUDIO_GOLDEN = savedGolden;
    if (savedControlLogDir === undefined) delete process.env.CONTROL_LOG_DIR;
    else process.env.CONTROL_LOG_DIR = savedControlLogDir;
    await fixture.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("design golden text flows correctly through SSE pipeline", async () => {
    const stream = streamTurn("Update the README", tmpDir, "design");
    const events = await collectSse(stream);

    const dataEvents = events.filter((e) => !e.event && e.data.trim() !== "");
    const combined = dataEvents.map((e) => e.data).join("\n");

    expect(combined).toContain("Changes made:");
    expect(events.find((e) => e.event === "done")).toBeDefined();
  });

  it("design golden JSONL log entry contains the correct message and non-empty response", async () => {
    const stream = streamTurn("Update README docs", tmpDir, "design");
    await collectSse(stream);

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(tmpDir, `${today}.jsonl`);
    expect(existsSync(logFile)).toBe(true);

    const lines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const entry = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(entry.message).toBe("Update README docs");
    expect(typeof entry.response).toBe("string");
    expect((entry.response as string).length).toBeGreaterThan(0);
  });
});
