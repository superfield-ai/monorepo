import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { spawnAgent } from "../../agent.ts";

type MockProc = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
};

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  spawnMock.mockReset();
  delete process.env.SUPERFIELD_AGENT_PROVIDER;
});

function makeProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  return proc;
}

function finish(proc: MockProc, stdout: string, stderr = "", code = 0): void {
  proc.stdout.end(stdout);
  proc.stderr.end(stderr);
  proc.emit("close", code);
}

describe("spawnAgent", () => {
  it("uses claude by default", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    spawnMock.mockImplementation((command: string, args: string[]) => {
      calls.push({ command, args });
      const proc = makeProc();
      queueMicrotask(() =>
        finish(
          proc,
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "claude-sess",
            result: '{"ok":true}',
          }),
        ),
      );
      return proc;
    });

    const result = await spawnAgent({
      worktreePath: "/tmp/work",
      prompt: "hello",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("claude");
    expect(calls[0]!.args).toContain("--output-format");
    expect(result).toEqual({
      sessionId: "claude-sess",
      output: '{"ok":true}',
      isError: false,
    });
  });

  it("uses codex when explicitly requested", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    spawnMock.mockImplementation((command: string, args: string[]) => {
      calls.push({ command, args });
      const proc = makeProc();
      queueMicrotask(() =>
        finish(
          proc,
          [
            '{"type":"thread.started","thread_id":"codex-thread"}',
            '{"type":"turn.started"}',
            '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"answer\\":42}"}}',
            '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
          ].join("\n"),
        ),
      );
      return proc;
    });

    const result = await spawnAgent({
      provider: "codex",
      worktreePath: "/tmp/work",
      prompt: "hello",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("codex");
    expect(calls[0]!.args).toContain("exec");
    expect(calls[0]!.args).toContain("--json");
    expect(result).toEqual({
      sessionId: "codex-thread",
      output: '{"answer":42}',
      isError: false,
    });
  });

  it("falls back to codex when claude is rate limited", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    spawnMock.mockImplementation((command: string, args: string[]) => {
      calls.push({ command, args });
      const proc = makeProc();
      queueMicrotask(() => {
        if (calls.length === 1) {
          finish(
            proc,
            JSON.stringify({
              type: "result",
              subtype: "error",
              is_error: true,
              session_id: "claude-sess",
              error: "429 rate limit exceeded",
            }),
          );
          return;
        }

        finish(
          proc,
          [
            '{"type":"thread.started","thread_id":"codex-thread"}',
            '{"type":"turn.started"}',
            '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"answer\\":42}"}}',
            '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
          ].join("\n"),
        );
      });
      return proc;
    });

    const result = await spawnAgent({
      worktreePath: "/tmp/work",
      prompt: "hello",
    });

    expect(calls.map((call) => call.command)).toEqual(["claude", "codex"]);
    expect(result.sessionId).toBe("codex-thread");
    expect(result.output).toBe('{"answer":42}');
  });

  it("falls back to codex when claude says you've hit your limit", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    spawnMock.mockImplementation((command: string, args: string[]) => {
      calls.push({ command, args });
      const proc = makeProc();
      queueMicrotask(() => {
        if (calls.length === 1) {
          finish(
            proc,
            JSON.stringify({
              type: "result",
              subtype: "error",
              is_error: true,
              session_id: "claude-sess",
              error: "You've hit your limit · resets 8pm (UTC)",
            }),
          );
          return;
        }

        finish(
          proc,
          [
            '{"type":"thread.started","thread_id":"codex-thread"}',
            '{"type":"turn.started"}',
            '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"answer\\":42}"}}',
            '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
          ].join("\n"),
        );
      });
      return proc;
    });

    const result = await spawnAgent({
      worktreePath: "/tmp/work",
      prompt: "hello",
    });

    expect(calls.map((call) => call.command)).toEqual(["claude", "codex"]);
    expect(result.sessionId).toBe("codex-thread");
    expect(result.output).toBe('{"answer":42}');
  });

  it("maps claude model alias when falling back to codex", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    spawnMock.mockImplementation((command: string, args: string[]) => {
      calls.push({ command, args });
      const proc = makeProc();
      queueMicrotask(() => {
        if (calls.length === 1) {
          finish(
            proc,
            JSON.stringify({
              type: "result",
              subtype: "error",
              is_error: true,
              session_id: "claude-sess",
              error: "You've hit your limit · resets 8pm (UTC)",
            }),
          );
          return;
        }

        finish(
          proc,
          [
            '{"type":"thread.started","thread_id":"codex-thread"}',
            '{"type":"turn.started"}',
            '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
            '{"type":"turn.completed"}',
          ].join("\n"),
        );
      });
      return proc;
    });

    await spawnAgent({
      worktreePath: "/tmp/work",
      prompt: "hello",
      model: "haiku",
    });

    expect(calls.map((call) => call.command)).toEqual(["claude", "codex"]);
    expect(calls[1]!.args).toContain("--model");
    expect(calls[1]!.args).toContain("gpt-5.4-mini");
  });

  it("retries codex fallback without model if mapped model is rejected", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    spawnMock.mockImplementation((command: string, args: string[]) => {
      calls.push({ command, args });
      const proc = makeProc();
      queueMicrotask(() => {
        if (calls.length === 1) {
          finish(
            proc,
            JSON.stringify({
              type: "result",
              subtype: "error",
              is_error: true,
              session_id: "claude-sess",
              error: "You've hit your limit · resets 8pm (UTC)",
            }),
          );
          return;
        }
        if (calls.length === 2) {
          finish(
            proc,
            '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"model is not supported"}}',
            "",
            1,
          );
          return;
        }
        finish(
          proc,
          [
            '{"type":"thread.started","thread_id":"codex-thread"}',
            '{"type":"turn.started"}',
            '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
            '{"type":"turn.completed"}',
          ].join("\n"),
        );
      });
      return proc;
    });

    const result = await spawnAgent({
      worktreePath: "/tmp/work",
      prompt: "hello",
      model: "haiku",
    });

    expect(calls.map((call) => call.command)).toEqual([
      "claude",
      "codex",
      "codex",
    ]);
    expect(calls[1]!.args).toContain("--model");
    expect(calls[1]!.args).toContain("gpt-5.4-mini");
    expect(calls[2]!.args).not.toContain("--model");
    expect(result.sessionId).toBe("codex-thread");
  });
});
