/**
 * @file packages/core/tests/spawn.test.ts
 *
 * Unit tests for the spawn wrapper's stdin piping and streaming support.
 *
 * Issue #21 test plan item:
 *   - Unit: spawn wrapper correctly pipes stdin to child process
 *
 * Issue #57 test plan items:
 *   - Unit: spawn wrapper with stream:true uses stdio:'inherit'
 *   - Unit: stream mode returns empty stdout/stderr with correct exit status
 *   - Unit: piped mode (default) still captures stdout/stderr correctly
 *
 * The spawn wrapper was extended to accept opts.input, which pipes
 * a string into the child process's stdin. This is used by
 * applyManifests() to feed concatenated YAML into kubectl apply.
 *
 * The spawn wrapper was also extended to accept opts.stream, which
 * passes stdio:'inherit' so long-running commands like docker build
 * show live output instead of hanging silently.
 *
 * @see packages/core/spawn.ts
 * @see docs/cluster-definition.md — "Startup sequence" step 8
 */

import { describe, it, expect } from "vitest";
import { spawn } from "../spawn";

describe("spawn", () => {
  it("runs a simple command and captures stdout", () => {
    const result = spawn("echo", ["hello"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("returns non-zero status for failing commands", () => {
    const result = spawn("false", []);
    expect(result.status).not.toBe(0);
  });

  it("pipes stdin input to the child process", () => {
    // Use cat to echo back whatever is piped into stdin.
    const result = spawn("cat", [], { input: "hello from stdin" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
  });

  it("pipes multi-line stdin input correctly", () => {
    const multiLine = "line1\nline2\nline3";
    const result = spawn("cat", [], { input: multiLine });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(multiLine);
  });

  it("pipes stdin with special characters", () => {
    const yaml = "apiVersion: v1\nkind: Service\nmetadata:\n  name: test-svc";
    const result = spawn("cat", [], { input: yaml });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(yaml);
  });

  it("supports cwd option", () => {
    const result = spawn("pwd", [], { cwd: "/tmp" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("/tmp");
  });

  it("supports both cwd and input simultaneously", () => {
    const result = spawn("cat", [], { cwd: "/tmp", input: "combined test" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("combined test");
  });

  describe("stream mode", () => {
    it("returns exit status 0 for a successful command in stream mode", () => {
      // In stream mode stdio is 'inherit', so stdout/stderr are not captured.
      const result = spawn("true", [], { stream: true });
      expect(result.status).toBe(0);
    });

    it("returns non-zero status for a failing command in stream mode", () => {
      const result = spawn("false", [], { stream: true });
      expect(result.status).not.toBe(0);
    });

    it("returns empty stdout in stream mode", () => {
      // stdout is not captured when stream:true — output goes to the terminal.
      const result = spawn("echo", ["hello"], { stream: true });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("returns empty stderr in stream mode", () => {
      const result = spawn("true", [], { stream: true });
      expect(result.stderr).toBe("");
    });

    it("supports cwd option in stream mode", () => {
      const result = spawn("true", [], { stream: true, cwd: "/tmp" });
      expect(result.status).toBe(0);
    });

    it("piped mode still captures stdout when stream is not set", () => {
      const result = spawn("echo", ["captured"]);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("captured");
    });
  });
});
