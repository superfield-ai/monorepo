import { describe, it, expect } from "vitest";
import { fakeSpawn, makeAgentResult } from "../helpers/fake-spawn.ts";
import { replaySpawn, loadClaudeFixture } from "../helpers/replay.ts";
import { replayCodexSpawn, loadCodexFixture } from "../helpers/codex-replay.ts";
import { isLiveMode, liveBackends } from "../helpers/live.ts";
import * as path from "node:path";

describe("helpers/fake-spawn", () => {
  describe("makeAgentResult", () => {
    it("creates a default success result", () => {
      const result = makeAgentResult({ output: '{"ok":true}' });
      expect(result.sessionId).toMatch(/^test-sess-/);
      expect(result.output).toBe('{"ok":true}');
      expect(result.isError).toBe(false);
    });

    it("lets caller override sessionId and isError", () => {
      const result = makeAgentResult({
        output: "failed",
        sessionId: "sess-custom",
        isError: true,
      });
      expect(result.sessionId).toBe("sess-custom");
      expect(result.isError).toBe(true);
    });
  });

  describe("fakeSpawn", () => {
    it("returns a function that resolves to the canned result", async () => {
      const spawn = fakeSpawn({ output: '{"a":1}' });
      const res = await spawn({ prompt: "x", worktreePath: "/tmp" });
      expect(res.output).toBe('{"a":1}');
      expect(res.isError).toBe(false);
    });

    it("rotates through multiple responses on consecutive calls", async () => {
      const spawn = fakeSpawn([
        { output: '{"first":1}' },
        { output: '{"second":2}' },
        { output: '{"third":3}' },
      ]);
      const r1 = await spawn({ prompt: "a", worktreePath: "/tmp" });
      const r2 = await spawn({ prompt: "b", worktreePath: "/tmp" });
      const r3 = await spawn({ prompt: "c", worktreePath: "/tmp" });
      expect(r1.output).toBe('{"first":1}');
      expect(r2.output).toBe('{"second":2}');
      expect(r3.output).toBe('{"third":3}');
    });

    it("repeats the last response after the array is exhausted", async () => {
      const spawn = fakeSpawn([{ output: '{"only":1}' }]);
      const r1 = await spawn({ prompt: "a", worktreePath: "/tmp" });
      const r2 = await spawn({ prompt: "b", worktreePath: "/tmp" });
      expect(r1.output).toBe('{"only":1}');
      expect(r2.output).toBe('{"only":1}');
    });

    it("throws synchronously when given an error response", async () => {
      const spawn = fakeSpawn({ output: "boom", isError: true });
      const res = await spawn({ prompt: "a", worktreePath: "/tmp" });
      expect(res.isError).toBe(true);
    });
  });
});

describe("helpers/replay", () => {
  const FIXTURES_DIR = path.resolve(
    import.meta.dirname,
    "../../../../tests/fixtures/claude",
  );

  describe("loadClaudeFixture", () => {
    it("loads the test fixture file as a JSON object", async () => {
      const fixture = await loadClaudeFixture("test-sample", FIXTURES_DIR);
      expect(fixture.sessionId).toBeDefined();
      expect(typeof fixture.output).toBe("string");
    });

    it("throws a clear error when fixture is missing", async () => {
      await expect(
        loadClaudeFixture("does-not-exist", FIXTURES_DIR),
      ).rejects.toThrow(/does-not-exist/);
    });
  });

  describe("replaySpawn", () => {
    it("returns a spawn function that emits the fixture output", async () => {
      const spawn = await replaySpawn("test-sample", FIXTURES_DIR);
      const res = await spawn({ prompt: "anything", worktreePath: "/tmp" });
      expect(res.output).toContain("issue_number");
    });

    it("passes through sessionId from the fixture", async () => {
      const spawn = await replaySpawn("test-sample", FIXTURES_DIR);
      const res = await spawn({ prompt: "x", worktreePath: "/tmp" });
      expect(res.sessionId).toMatch(/^01J/);
    });
  });
});

describe("helpers/codex-replay", () => {
  const FIXTURES_DIR = path.resolve(
    import.meta.dirname,
    "../../../../tests/fixtures/codex",
  );

  describe("loadCodexFixture", () => {
    it("loads the codex JSONL fixture as raw text", async () => {
      const fixture = await loadCodexFixture("test-sample", FIXTURES_DIR);
      expect(fixture).toContain("thread.started");
      expect(fixture).toContain('\\"answer\\":42');
    });

    it("throws a clear error when fixture is missing", async () => {
      await expect(
        loadCodexFixture("does-not-exist", FIXTURES_DIR),
      ).rejects.toThrow(/does-not-exist/);
    });
  });

  describe("replayCodexSpawn", () => {
    it("returns a spawn function that emits the fixture output", async () => {
      const spawn = await replayCodexSpawn("test-sample", FIXTURES_DIR);
      const res = await spawn({ prompt: "anything", worktreePath: "/tmp" });
      expect(res.sessionId).toMatch(/^019d6e98-/);
      expect(res.output).toContain('"answer":42');
    });
  });
});

describe("helpers/live", () => {
  it("returns false when SUPERFIELD_LIVE_AGENTS is unset", () => {
    delete process.env.SUPERFIELD_LIVE_AGENTS;
    expect(isLiveMode()).toBe(false);
  });

  it("returns false when SUPERFIELD_LIVE_AGENTS is empty", () => {
    process.env.SUPERFIELD_LIVE_AGENTS = "";
    expect(isLiveMode()).toBe(false);
  });

  it("returns true when SUPERFIELD_LIVE_AGENTS=1", () => {
    process.env.SUPERFIELD_LIVE_AGENTS = "1";
    expect(isLiveMode()).toBe(true);
    delete process.env.SUPERFIELD_LIVE_AGENTS;
  });

  it("returns true for any non-empty value", () => {
    process.env.SUPERFIELD_LIVE_AGENTS = "yes";
    expect(isLiveMode()).toBe(true);
    delete process.env.SUPERFIELD_LIVE_AGENTS;
  });

  it("returns both backends by default", () => {
    delete process.env.SUPERFIELD_LIVE_AGENTS;
    expect(liveBackends()).toEqual(["claude", "codex"]);
  });

  it("filters backends by env value", () => {
    process.env.SUPERFIELD_LIVE_AGENTS = "codex";
    expect(liveBackends()).toEqual(["codex"]);
    delete process.env.SUPERFIELD_LIVE_AGENTS;
  });
});
