import { describe, it, expect } from "vitest";
import { runAudit } from "../../../commands/audit.ts";
import { CAPABILITIES } from "../../../audit/capabilities.ts";
import type { AgentOpts, AgentResult } from "../../../agent.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Two real capability IDs — derived at import time so tests stay in sync with
// whatever the blueprint defines.
const [CAP_A, CAP_B] = CAPABILITIES.map((c) => c.id) as [string, string];

function makeFinding(capabilityId: string, conformant = true): string {
  return JSON.stringify({
    capabilityId,
    present: true,
    conformant,
    gaps: conformant ? [] : ["gap-1"],
    evidence: ["evidence-1"],
    summary: `Summary for ${capabilityId}`,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAudit", () => {
  it("returns a summary with the correct capability IDs when all checks pass", async () => {
    const written: Record<string, string> = {};

    const summary = await runAudit({
      repoPath: "/tmp/fake-repo",
      outputDir: "/tmp/fake-audit",
      capabilities: [CAP_A],
      noIssues: true,
      deps: {
        mkdir: async () => {},
        readFile: async () => null,
        writeFile: async (p, c) => {
          written[p] = c;
        },
        onLog: () => {},
        spawnAgent: async (_opts: AgentOpts): Promise<AgentResult> => ({
          sessionId: "sess-1",
          output: makeFinding(CAP_A, true),
          isError: false,
        }),
      },
    });

    expect(summary.capabilities).toContain(CAP_A);
    expect(summary.conformant).toContain(CAP_A);
    expect(summary.nonConformant).toHaveLength(0);
    expect(summary.absent).toHaveLength(0);
    // The individual finding JSON must have been written to disk.
    expect(written[`/tmp/fake-audit/${CAP_A}.json`]).toBeTruthy();
    // The summary JSON must also be written.
    expect(written["/tmp/fake-audit/summary.json"]).toBeTruthy();
  });

  it("runs all requested capabilities and collects findings from each", async () => {
    const spawnCalls: string[] = [];

    // Map capability name (task) back to cap id by index order.
    const capIds = [CAP_A, CAP_B];

    const summary = await runAudit({
      repoPath: "/tmp/fake-repo",
      outputDir: "/tmp/fake-audit",
      capabilities: capIds,
      noIssues: true,
      deps: {
        mkdir: async () => {},
        readFile: async () => null,
        writeFile: async () => {},
        onLog: () => {},
        spawnAgent: async (opts: AgentOpts): Promise<AgentResult> => {
          spawnCalls.push(opts.task ?? "");
          const idx = spawnCalls.length - 1;
          return {
            sessionId: `sess-${idx}`,
            output: makeFinding(capIds[idx] ?? CAP_A, true),
            isError: false,
          };
        },
      },
    });

    // Both capabilities should produce findings.
    expect(summary.capabilities).toHaveLength(2);
    expect(summary.capabilities).toContain(CAP_A);
    expect(summary.capabilities).toContain(CAP_B);
    // spawn was called once per capability.
    expect(spawnCalls).toHaveLength(2);
  });

  it("skips capabilities whose finding file already exists on disk (resume mode — git unavailable)", async () => {
    const existingFinding = JSON.stringify({
      capabilityId: CAP_A,
      present: true,
      conformant: true,
      gaps: [],
      evidence: [],
      summary: "already done",
      checkedAt: new Date().toISOString(),
    });

    const spawnCalls: string[] = [];

    const summary = await runAudit({
      repoPath: "/tmp/fake-repo",
      outputDir: "/tmp/fake-audit",
      capabilities: [CAP_A],
      noIssues: true,
      deps: {
        mkdir: async () => {},
        readFile: async () => existingFinding,
        writeFile: async () => {},
        onLog: () => {},
        // headTimeMs === 0 → git unavailable → legacy resume-on-crash
        getHeadTime: async () => 0,
        statFn: async () => ({ mtimeMs: Date.now() }),
        spawnAgent: async (opts: AgentOpts): Promise<AgentResult> => {
          spawnCalls.push(opts.task ?? "");
          return {
            sessionId: "sess-1",
            output: makeFinding(CAP_A, true),
            isError: false,
          };
        },
      },
    });

    // spawn should NOT be called — existing finding was reused.
    expect(spawnCalls).toHaveLength(0);
    expect(summary.capabilities).toContain(CAP_A);
  });

  it("skips capabilities whose finding is newer than HEAD commit (stale-check)", async () => {
    const existingFinding = JSON.stringify({
      capabilityId: CAP_A,
      present: true,
      conformant: true,
      gaps: [],
      evidence: [],
      summary: "already done",
      checkedAt: new Date().toISOString(),
    });

    const headTimeMs = 1_000_000_000_000; // some past time
    const findingMtimeMs = headTimeMs + 5_000; // finding is 5 s newer than HEAD

    const spawnCalls: string[] = [];

    const summary = await runAudit({
      repoPath: "/tmp/fake-repo",
      outputDir: "/tmp/fake-audit",
      capabilities: [CAP_A],
      noIssues: true,
      deps: {
        mkdir: async () => {},
        readFile: async () => existingFinding,
        writeFile: async () => {},
        onLog: () => {},
        getHeadTime: async () => headTimeMs,
        statFn: async () => ({ mtimeMs: findingMtimeMs }),
        spawnAgent: async (opts: AgentOpts): Promise<AgentResult> => {
          spawnCalls.push(opts.task ?? "");
          return {
            sessionId: "sess-1",
            output: makeFinding(CAP_A, true),
            isError: false,
          };
        },
      },
    });

    // spawn should NOT be called — finding is fresh.
    expect(spawnCalls).toHaveLength(0);
    expect(summary.capabilities).toContain(CAP_A);
  });

  it("re-runs capabilities whose finding is older than HEAD commit", async () => {
    const existingFinding = JSON.stringify({
      capabilityId: CAP_A,
      present: true,
      conformant: true,
      gaps: [],
      evidence: [],
      summary: "stale finding",
      checkedAt: new Date().toISOString(),
    });

    const headTimeMs = 1_000_000_000_000;
    const findingMtimeMs = headTimeMs - 5_000; // finding is 5 s OLDER than HEAD

    const spawnCalls: string[] = [];

    await runAudit({
      repoPath: "/tmp/fake-repo",
      outputDir: "/tmp/fake-audit",
      capabilities: [CAP_A],
      noIssues: true,
      deps: {
        mkdir: async () => {},
        readFile: async () => existingFinding,
        writeFile: async () => {},
        onLog: () => {},
        getHeadTime: async () => headTimeMs,
        statFn: async () => ({ mtimeMs: findingMtimeMs }),
        spawnAgent: async (opts: AgentOpts): Promise<AgentResult> => {
          spawnCalls.push(opts.task ?? "");
          return {
            sessionId: "sess-1",
            output: makeFinding(CAP_A, true),
            isError: false,
          };
        },
      },
    });

    // spawn SHOULD be called — finding is stale.
    expect(spawnCalls).toHaveLength(1);
  });

  it("re-runs capabilities when force=true even if finding is newer than HEAD", async () => {
    const existingFinding = JSON.stringify({
      capabilityId: CAP_A,
      present: true,
      conformant: true,
      gaps: [],
      evidence: [],
      summary: "fresh finding",
      checkedAt: new Date().toISOString(),
    });

    const headTimeMs = 1_000_000_000_000;
    const findingMtimeMs = headTimeMs + 10_000; // finding is newer than HEAD

    const spawnCalls: string[] = [];

    await runAudit({
      repoPath: "/tmp/fake-repo",
      outputDir: "/tmp/fake-audit",
      capabilities: [CAP_A],
      noIssues: true,
      force: true, // bypass stale-check
      deps: {
        mkdir: async () => {},
        readFile: async () => existingFinding,
        writeFile: async () => {},
        onLog: () => {},
        getHeadTime: async () => headTimeMs,
        statFn: async () => ({ mtimeMs: findingMtimeMs }),
        spawnAgent: async (opts: AgentOpts): Promise<AgentResult> => {
          spawnCalls.push(opts.task ?? "");
          return {
            sessionId: "sess-1",
            output: makeFinding(CAP_A, true),
            isError: false,
          };
        },
      },
    });

    // spawn SHOULD be called — force bypasses the stale-check.
    expect(spawnCalls).toHaveLength(1);
  });

  it("continues other capabilities when one agent call fails", async () => {
    let callCount = 0;
    const summary = await runAudit({
      repoPath: "/tmp/fake-repo",
      outputDir: "/tmp/fake-audit",
      capabilities: [CAP_A, CAP_B],
      noIssues: true,
      deps: {
        mkdir: async () => {},
        readFile: async () => null,
        writeFile: async () => {},
        onLog: () => {},
        spawnAgent: async (_opts: AgentOpts): Promise<AgentResult> => {
          callCount++;
          if (callCount === 1) {
            // First call: simulate agent error.
            return {
              sessionId: "sess-err",
              output: "something went wrong",
              isError: true,
            };
          }
          return {
            sessionId: `sess-${callCount}`,
            output: makeFinding(CAP_B, true),
            isError: false,
          };
        },
      },
    });

    // Second capability should still appear in findings despite first failing.
    expect(summary.capabilities).toContain(CAP_B);
    // Both agents were invoked.
    expect(callCount).toBe(2);
  });

  it("throws when no capability IDs match", async () => {
    await expect(
      runAudit({
        repoPath: "/tmp/fake-repo",
        outputDir: "/tmp/fake-audit",
        capabilities: ["this-does-not-exist-xyz"],
        noIssues: true,
        deps: {
          mkdir: async () => {},
          readFile: async () => null,
          writeFile: async () => {},
          onLog: () => {},
        },
      }),
    ).rejects.toThrow(/No capabilities matched/);
  });

  it("records non-conformant capabilities in the summary", async () => {
    const summary = await runAudit({
      repoPath: "/tmp/fake-repo",
      outputDir: "/tmp/fake-audit",
      capabilities: [CAP_A],
      noIssues: true,
      deps: {
        mkdir: async () => {},
        readFile: async () => null,
        writeFile: async () => {},
        onLog: () => {},
        spawnAgent: async (): Promise<AgentResult> => ({
          sessionId: "sess-1",
          output: makeFinding(CAP_A, false), // not conformant
          isError: false,
        }),
      },
    });

    expect(summary.nonConformant).toContain(CAP_A);
    expect(summary.conformant).not.toContain(CAP_A);
  });
});
