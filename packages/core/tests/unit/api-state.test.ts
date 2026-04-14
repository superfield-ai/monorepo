import { describe, it, expect } from "vitest";
import { ApiState } from "../../api-state.js";

describe("ApiState", () => {
  it("tracks a slot from start to end", () => {
    const s = new ApiState();
    s.recordAgentStart({
      slot: 1, issueNumber: 42, role: "primary",
      sessionId: "claude-abc", backend: "claude",
      model: "claude-sonnet-4-6", startedAt: "2026-01-01T00:00:00Z",
    });
    expect(s.slots.size).toBe(1);
    expect(s.slots.get(1)?.sessionId).toBe("claude-abc");

    s.recordAgentEnd(1, 0.05, "claude", false);
    expect(s.slots.size).toBe(0);
    expect(s.costs.totalUsd).toBeCloseTo(0.05);
    expect(s.costs.agentCount).toBe(1);
  });

  it("accumulates errors separately", () => {
    const s = new ApiState();
    s.recordAgentStart({ slot: 1, issueNumber: 1, role: "primary",
      sessionId: "s1", backend: "claude", model: "m", startedAt: "" });
    s.recordAgentEnd(1, 0, "claude", true);
    expect(s.costs.errorCount).toBe(1);
  });

  it("accumulates cost by backend", () => {
    const s = new ApiState();
    s.recordAgentStart({ slot: 1, issueNumber: 1, role: "primary",
      sessionId: "s1", backend: "claude", model: "m", startedAt: "" });
    s.recordAgentEnd(1, 0.10, "claude", false);
    s.recordAgentStart({ slot: 2, issueNumber: 2, role: "speculative",
      sessionId: "s2", backend: "codex", model: "m2", startedAt: "" });
    s.recordAgentEnd(2, 0.05, "codex", false);
    expect(s.costs.totalUsd).toBeCloseTo(0.15);
    expect(s.costs.byBackend["claude"]).toBeCloseTo(0.10);
    expect(s.costs.byBackend["codex"]).toBeCloseTo(0.05);
    expect(s.costs.agentCount).toBe(2);
  });

  it("consumeSteer returns and removes the pending steer", () => {
    const s = new ApiState();
    s.recordAgentStart({ slot: 1, issueNumber: 1, role: "primary",
      sessionId: "claude-xyz", backend: "claude", model: "m", startedAt: "" });
    s.pendingSteers.set("claude-xyz", {
      requestId: "r1", context: "do this instead", queuedAt: Date.now(),
    });
    const steer = s.consumeSteer("claude-xyz");
    expect(steer?.context).toBe("do this instead");
    expect(s.pendingSteers.size).toBe(0);
  });

  it("consumeSteer returns undefined for unknown session", () => {
    const s = new ApiState();
    expect(s.consumeSteer("nonexistent")).toBeUndefined();
  });

  it("consumeEscalation returns and removes the pending escalation", () => {
    const s = new ApiState();
    s.pendingEscalations.set(42, { requestId: "e1", queuedAt: Date.now() });
    const esc = s.consumeEscalation(42);
    expect(esc?.requestId).toBe("e1");
    expect(s.pendingEscalations.size).toBe(0);
  });

  it("consumeEscalation returns undefined for unknown issue", () => {
    const s = new ApiState();
    expect(s.consumeEscalation(999)).toBeUndefined();
  });

  it("recordCircuitTripped sets circuit state", () => {
    const s = new ApiState();
    expect(s.loops.dev.circuitTripped).toBe(false);
    s.recordCircuitTripped(5);
    expect(s.loops.dev.circuitTripped).toBe(true);
    expect(s.loops.dev.consecutiveFailures).toBe(5);
  });

  it("recordCircuitReset clears circuit state", () => {
    const s = new ApiState();
    s.recordCircuitTripped(5);
    s.recordCircuitReset();
    expect(s.loops.dev.circuitTripped).toBe(false);
    expect(s.loops.dev.consecutiveFailures).toBe(0);
  });

  it("recordHeartbeat updates elapsed time and heartbeatAt", () => {
    const s = new ApiState();
    s.recordAgentStart({ slot: 1, issueNumber: 1, role: "primary",
      sessionId: "s1", backend: "claude", model: "m", startedAt: "" });
    const before = Date.now();
    s.recordHeartbeat(1, 30_000);
    const after = Date.now();
    expect(s.slots.get(1)?.elapsedMs).toBe(30_000);
    expect(s.slots.get(1)?.heartbeatAt).toBeGreaterThanOrEqual(before);
    expect(s.slots.get(1)?.heartbeatAt).toBeLessThanOrEqual(after);
  });

  it("recordLoopTick updates loop health", () => {
    const s = new ApiState();
    const before = Date.now();
    s.recordLoopTick("plan", 100, "idle reason");
    const after = Date.now();
    expect(s.loops.plan.lastTickDurationMs).toBe(100);
    expect(s.loops.plan.idleReason).toBe("idle reason");
    expect(s.loops.plan.lastTickAt).toBeGreaterThanOrEqual(before);
    expect(s.loops.plan.lastTickAt).toBeLessThanOrEqual(after);
  });
});
