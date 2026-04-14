import { createServer } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { ApiState } from "../../api-state.js";
import { startApiServer } from "../../api-server.js";
import type { Logger } from "../../logger.js";

let port: number;
let state: ApiState;

const noopLogger: Logger = {
  currentLevel: "info",
  emit: () => {},
};

// Allocate a free port, then start the API server and wait for it to bind
beforeAll(
  () =>
    new Promise<void>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        port = (probe.address() as AddressInfo).port;
        probe.close(() => {
          state = new ApiState();
          const srv = startApiServer({ port, state, logger: noopLogger });
          srv.once("listening", resolve);
        });
      });
    }),
);

afterAll(() => Promise.resolve());

async function get(path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function startSlot(slot: number, issueNumber: number, sessionId: string) {
  state.recordAgentStart({
    slot,
    issueNumber,
    role: "primary",
    sessionId,
    backend: "claude",
    model: "claude-sonnet-4-6",
    startedAt: new Date().toISOString(),
  });
}

// ── /health ────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns ok", async () => {
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

// ── /analytics/slots ───────────────────────────────────────────────────────

describe("GET /analytics/slots", () => {
  it("returns empty array when no agents running", async () => {
    const { body } = await get("/analytics/slots");
    expect(body.slots).toEqual([]);
  });

  it("reflects a recorded slot and clears after end", async () => {
    startSlot(1, 99, "sess-1");
    const { body } = await get("/analytics/slots");
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0].issueNumber).toBe(99);
    expect(body.slots[0].sessionId).toBe("sess-1");
    state.recordAgentEnd(1, 0, "claude", false);
    const after = await get("/analytics/slots");
    expect(after.body.slots).toHaveLength(0);
  });
});

// ── /analytics/sessions ────────────────────────────────────────────────────

describe("GET /analytics/sessions", () => {
  it("returns empty array when no agents running", async () => {
    const { status, body } = await get("/analytics/sessions");
    expect(status).toBe(200);
    expect(body.sessions).toEqual([]);
  });

  it("returns session-keyed fields for active slot", async () => {
    startSlot(2, 55, "sess-2");
    const { body } = await get("/analytics/sessions");
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionId).toBe("sess-2");
    expect(body.sessions[0].issueNumber).toBe(55);
    state.recordAgentEnd(2, 0, "claude", false);
  });
});

// ── /analytics/status ─────────────────────────────────────────────────────

describe("GET /analytics/status", () => {
  it("returns summary with expected shape", async () => {
    const { status, body } = await get("/analytics/status");
    expect(status).toBe(200);
    expect(typeof body.activeSlots).toBe("number");
    expect(typeof body.totalCostUsd).toBe("number");
    expect(body.loopHealth).toBeDefined();
  });

  it("reflects active slot count", async () => {
    startSlot(3, 11, "sess-3");
    const { body } = await get("/analytics/status");
    expect(body.activeSlots).toBe(1);
    state.recordAgentEnd(3, 0, "claude", false);
  });
});

// ── /analytics/loops ──────────────────────────────────────────────────────

describe("GET /analytics/loops", () => {
  it("returns all three loop entries", async () => {
    const { status, body } = await get("/analytics/loops");
    expect(status).toBe(200);
    expect(body.loops.dev).toBeDefined();
    expect(body.loops.plan).toBeDefined();
    expect(body.loops.doc).toBeDefined();
  });

  it("reflects a recorded loop tick", async () => {
    state.recordLoopTick("dev", 42, "waiting for issue");
    const { body } = await get("/analytics/loops");
    expect(body.loops.dev.lastTickDurationMs).toBe(42);
    expect(body.loops.dev.idleReason).toBe("waiting for issue");
  });
});

// ── /analytics/costs ──────────────────────────────────────────────────────

describe("GET /analytics/costs", () => {
  it("returns costs shape", async () => {
    const { status, body } = await get("/analytics/costs");
    expect(status).toBe(200);
    expect(typeof body.costs.totalUsd).toBe("number");
    expect(typeof body.costs.agentCount).toBe("number");
  });
});

// ── /analytics/circuit ────────────────────────────────────────────────────

describe("GET /analytics/circuit", () => {
  it("returns circuit breaker state", async () => {
    const { status, body } = await get("/analytics/circuit");
    expect(status).toBe(200);
    expect(typeof body.tripped).toBe("boolean");
    expect(typeof body.consecutiveFailures).toBe("number");
  });

  it("reflects a tripped circuit", async () => {
    state.recordCircuitTripped(3);
    const { body } = await get("/analytics/circuit");
    expect(body.tripped).toBe(true);
    expect(body.consecutiveFailures).toBe(3);
    state.recordCircuitReset();
  });
});

// ── POST /steer/context ───────────────────────────────────────────────────

describe("POST /steer/context", () => {
  it("returns 400 when session_id is missing", async () => {
    const { status, body } = await post("/steer/context", {
      context: "do something",
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when context is missing", async () => {
    const { status } = await post("/steer/context", { session_id: "x" });
    expect(status).toBe(400);
  });

  it("returns 404 for unknown session", async () => {
    const { status, body } = await post("/steer/context", {
      session_id: "ghost",
      context: "do something",
    });
    expect(status).toBe(404);
    expect(body.accepted).toBe(false);
  });

  it("queues steer for active session and returns requestId", async () => {
    startSlot(4, 55, "sess-steer");
    const { status, body } = await post("/steer/context", {
      session_id: "sess-steer",
      context: "pivot to auth fix",
    });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.requestId).toBeTruthy();
    expect(state.pendingSteers.get("sess-steer")?.context).toBe(
      "pivot to auth fix",
    );
    state.recordAgentEnd(4, 0, "claude", false);
  });

  it("overwrites an existing pending steer with the latest", async () => {
    startSlot(5, 66, "sess-overwrite");
    await post("/steer/context", {
      session_id: "sess-overwrite",
      context: "first instruction",
    });
    await post("/steer/context", {
      session_id: "sess-overwrite",
      context: "second instruction",
    });
    expect(state.pendingSteers.get("sess-overwrite")?.context).toBe(
      "second instruction",
    );
    state.recordAgentEnd(5, 0, "claude", false);
  });

  it("steer is consumed once and then gone", async () => {
    startSlot(6, 77, "sess-consume");
    await post("/steer/context", {
      session_id: "sess-consume",
      context: "do the thing",
    });
    const first = state.consumeSteer("sess-consume");
    expect(first?.context).toBe("do the thing");
    const second = state.consumeSteer("sess-consume");
    expect(second).toBeUndefined();
    state.recordAgentEnd(6, 0, "claude", false);
  });
});

// ── POST /steer/escalate ──────────────────────────────────────────────────

describe("POST /steer/escalate", () => {
  it("returns 400 when issue_number is missing", async () => {
    const { status } = await post("/steer/escalate", {});
    expect(status).toBe(400);
  });

  it("returns 404 for unknown issue", async () => {
    const { status, body } = await post("/steer/escalate", {
      issue_number: 9999,
    });
    expect(status).toBe(404);
    expect(body.accepted).toBe(false);
  });

  it("queues escalation for active issue and returns requestId", async () => {
    startSlot(7, 88, "sess-esc");
    const { status, body } = await post("/steer/escalate", {
      issue_number: 88,
    });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.requestId).toBeTruthy();
    expect(state.pendingEscalations.get(88)?.requestId).toBe(body.requestId);
    state.recordAgentEnd(7, 0, "claude", false);
  });

  it("escalation is consumed once and then gone", async () => {
    startSlot(8, 99, "sess-esc-consume");
    await post("/steer/escalate", { issue_number: 99 });
    const first = state.consumeEscalation(99);
    expect(first?.requestId).toBeTruthy();
    const second = state.consumeEscalation(99);
    expect(second).toBeUndefined();
    state.recordAgentEnd(8, 0, "claude", false);
  });
});

// ── unknown route ─────────────────────────────────────────────────────────

describe("unknown route", () => {
  it("returns 404", async () => {
    const { status } = await get("/nonexistent");
    expect(status).toBe(404);
  });
});
