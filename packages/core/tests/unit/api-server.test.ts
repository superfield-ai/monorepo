import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { ApiState } from "../../api-state.js";
import { startApiServer } from "../../api-server.js";
import type { Logger } from "../../logger.js";

// Use a throwaway port for tests
const PORT = 17837;
let state: ApiState;
let _server: Server | undefined;

const noopLogger: Logger = {
  currentLevel: "info",
  emit: () => {},
};

beforeAll(async () => {
  state = new ApiState();
  // startApiServer is non-blocking; wait a tick for listen to complete
  await new Promise<void>((resolve) => {
    const origListen = (server: Server) => {
      server.once("listening", resolve);
    };
    startApiServer({ port: PORT, state, logger: noopLogger });
    // Give the server a moment to bind
    setTimeout(resolve, 100);
  });
});

async function get(path: string) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("GET /health", () => {
  it("returns ok", async () => {
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

describe("GET /analytics/slots", () => {
  it("returns empty when no agents running", async () => {
    const { body } = await get("/analytics/slots");
    expect(body.slots).toEqual([]);
  });

  it("reflects a recorded slot", async () => {
    state.recordAgentStart({
      slot: 1, issueNumber: 99, role: "primary",
      sessionId: "claude-test", backend: "claude",
      model: "claude-sonnet-4-6", startedAt: new Date().toISOString(),
    });
    const { body } = await get("/analytics/slots");
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0].issueNumber).toBe(99);
    state.recordAgentEnd(1, 0, "claude", false);
  });
});

describe("GET /analytics/status", () => {
  it("returns status summary", async () => {
    const { status, body } = await get("/analytics/status");
    expect(status).toBe(200);
    expect(typeof body.activeSlots).toBe("number");
    expect(typeof body.totalCostUsd).toBe("number");
    expect(body.loopHealth).toBeDefined();
  });
});

describe("GET /analytics/loops", () => {
  it("returns loop health", async () => {
    const { status, body } = await get("/analytics/loops");
    expect(status).toBe(200);
    expect(body.loops).toBeDefined();
    expect(body.loops.dev).toBeDefined();
    expect(body.loops.plan).toBeDefined();
    expect(body.loops.doc).toBeDefined();
  });
});

describe("GET /analytics/costs", () => {
  it("returns costs", async () => {
    const { status, body } = await get("/analytics/costs");
    expect(status).toBe(200);
    expect(body.costs).toBeDefined();
    expect(typeof body.costs.totalUsd).toBe("number");
  });
});

describe("GET /analytics/circuit", () => {
  it("returns circuit breaker state", async () => {
    const { status, body } = await get("/analytics/circuit");
    expect(status).toBe(200);
    expect(typeof body.tripped).toBe("boolean");
    expect(typeof body.consecutiveFailures).toBe("number");
  });
});

describe("GET /analytics/sessions", () => {
  it("returns sessions", async () => {
    const { status, body } = await get("/analytics/sessions");
    expect(status).toBe(200);
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});

describe("POST /steer/context", () => {
  it("rejects unknown session", async () => {
    const { status, body } = await post("/steer/context", {
      session_id: "claude-nope",
      context: "do something",
    });
    expect(status).toBe(404);
    expect(body.accepted).toBe(false);
  });

  it("returns 400 when fields are missing", async () => {
    const { status } = await post("/steer/context", { session_id: "x" });
    expect(status).toBe(400);
  });

  it("accepts and queues steer for active session", async () => {
    state.recordAgentStart({
      slot: 2, issueNumber: 55, role: "primary",
      sessionId: "claude-live", backend: "claude",
      model: "claude-sonnet-4-6", startedAt: new Date().toISOString(),
    });
    const { status, body } = await post("/steer/context", {
      session_id: "claude-live",
      context: "pivot to fixing auth",
    });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.requestId).toBeTruthy();
    expect(state.pendingSteers.get("claude-live")?.context).toBe("pivot to fixing auth");
    state.recordAgentEnd(2, 0, "claude", false);
  });
});

describe("POST /steer/escalate", () => {
  it("rejects unknown issue", async () => {
    const { status, body } = await post("/steer/escalate", {
      issue_number: 9999,
    });
    expect(status).toBe(404);
    expect(body.accepted).toBe(false);
  });

  it("returns 400 when issue_number is missing", async () => {
    const { status } = await post("/steer/escalate", {});
    expect(status).toBe(400);
  });

  it("accepts and queues escalation for active issue", async () => {
    state.recordAgentStart({
      slot: 3, issueNumber: 77, role: "primary",
      sessionId: "claude-esc", backend: "claude",
      model: "claude-sonnet-4-6", startedAt: new Date().toISOString(),
    });
    const { status, body } = await post("/steer/escalate", {
      issue_number: 77,
    });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.requestId).toBeTruthy();
    expect(state.pendingEscalations.get(77)?.requestId).toBe(body.requestId);
    state.recordAgentEnd(3, 0, "claude", false);
  });
});

describe("unknown route", () => {
  it("returns 404", async () => {
    const { status } = await get("/nonexistent");
    expect(status).toBe(404);
  });
});
