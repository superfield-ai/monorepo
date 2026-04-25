# Superfield Analytics & Steering API

## Overview

Add an optional HTTP API server that starts in-process alongside the `start` command. The server exposes:

1. **Analytics** — live telemetry about running agents, loop health, cost, and session state.
2. **Steering** — allow external callers to inject context into an in-progress agent run within the same session.

The server is opt-out: it starts by default on `127.0.0.1:7837` and is suppressed with `--no-api`.

Because the server runs **in-process**, it shares memory directly with the loops — no IPC, no sidecar binary, no file bus.

---

## Architecture

```
superfield start <repo>
  │
  ├── Planning loop     (reads/writes shared ApiState)
  ├── Dev loop          (reads/writes shared ApiState)
  ├── Doc loop          (reads/writes shared ApiState)
  └── API server        (reads ApiState, accepts steer writes)
        │
        ├── GET  /health
        ├── GET  /analytics/status
        ├── GET  /analytics/sessions
        ├── GET  /analytics/slots
        ├── GET  /analytics/loops
        ├── GET  /analytics/costs
        ├── GET  /analytics/circuit
        ├── POST /steer/context
        └── POST /steer/escalate
```

The `ApiState` object is created in `startCommand()` and passed into both the loops and the HTTP server. Loops mutate it directly. The server reads it on every request.

---

## Tasks

### Task 1 — Shared state object

**New file:** `packages/core/api-state.ts`

```typescript
export interface SlotInfo {
  slot: number;
  issueNumber: number;
  role: "primary" | "speculative";
  sessionId: string;
  backend: string;
  model: string;
  startedAt: string; // ISO timestamp
  elapsedMs: number;
  heartbeatAt?: number; // Date.now() of last heartbeat
}

export interface LoopHealth {
  lastTickAt?: number;
  lastTickDurationMs?: number;
  idleReason?: string;
  circuitTripped: boolean;
  consecutiveFailures: number;
}

export interface CostAccumulator {
  totalUsd: number;
  byBackend: Record<string, number>;
  agentCount: number;
  errorCount: number;
}

export interface PendingSteer {
  requestId: string;
  context: string;
  queuedAt: number;
}

export interface PendingEscalate {
  requestId: string;
  queuedAt: number;
}

export class ApiState {
  slots = new Map<number, SlotInfo>();
  loops: Record<"plan" | "dev" | "doc", LoopHealth> = {
    plan: { circuitTripped: false, consecutiveFailures: 0 },
    dev: { circuitTripped: false, consecutiveFailures: 0 },
    doc: { circuitTripped: false, consecutiveFailures: 0 },
  };
  costs: CostAccumulator = {
    totalUsd: 0,
    byBackend: {},
    agentCount: 0,
    errorCount: 0,
  };
  // sessionId → pending steer (consumed once by the loop)
  pendingSteers = new Map<string, PendingSteer>();
  // issueNumber → pending escalation
  pendingEscalations = new Map<number, PendingEscalate>();

  // --- Loop-facing mutators ---

  recordAgentStart(info: Omit<SlotInfo, "elapsedMs" | "heartbeatAt">): void {
    this.slots.set(info.slot, { ...info, elapsedMs: 0 });
  }

  recordAgentEnd(
    slot: number,
    costUsd: number,
    backend: string,
    isError: boolean,
  ): void {
    this.slots.delete(slot);
    this.costs.totalUsd += costUsd;
    this.costs.byBackend[backend] =
      (this.costs.byBackend[backend] ?? 0) + costUsd;
    this.costs.agentCount += 1;
    if (isError) this.costs.errorCount += 1;
  }

  recordHeartbeat(slot: number, elapsedMs: number): void {
    const s = this.slots.get(slot);
    if (s) {
      s.elapsedMs = elapsedMs;
      s.heartbeatAt = Date.now();
    }
  }

  recordLoopTick(
    loop: "plan" | "dev" | "doc",
    durationMs: number,
    idleReason?: string,
  ): void {
    this.loops[loop].lastTickAt = Date.now();
    this.loops[loop].lastTickDurationMs = durationMs;
    this.loops[loop].idleReason = idleReason;
  }

  recordCircuitTripped(consecutiveFailures: number): void {
    this.loops.dev.circuitTripped = true;
    this.loops.dev.consecutiveFailures = consecutiveFailures;
  }

  recordCircuitReset(): void {
    this.loops.dev.circuitTripped = false;
    this.loops.dev.consecutiveFailures = 0;
  }

  // --- Steer consumers (called by loop on each heartbeat) ---

  consumeSteer(sessionId: string): PendingSteer | undefined {
    const s = this.pendingSteers.get(sessionId);
    if (s) this.pendingSteers.delete(sessionId);
    return s;
  }

  consumeEscalation(issueNumber: number): PendingEscalate | undefined {
    const e = this.pendingEscalations.get(issueNumber);
    if (e) this.pendingEscalations.delete(issueNumber);
    return e;
  }
}
```

---

### Task 2 — HTTP server

**New file:** `packages/core/api-server.ts`

Uses Node's built-in `http` module — no new dependencies.

```typescript
import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import type { ApiState } from "./api-state.js";
import type { Logger } from "./logger.js";

export interface ApiServerOpts {
  host?: string; // default "127.0.0.1"
  port?: number; // default 7837
  state: ApiState;
  logger: Logger;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

export function startApiServer(opts: ApiServerOpts): void {
  const { host = "127.0.0.1", port = 7837, state, logger } = opts;

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // GET /health
    if (method === "GET" && url === "/health") {
      return json(res, 200, { ok: true });
    }

    // GET /analytics/status
    if (method === "GET" && url === "/analytics/status") {
      return json(res, 200, {
        activeSlots: state.slots.size,
        loopHealth: state.loops,
        totalCostUsd: state.costs.totalUsd,
        agentCount: state.costs.agentCount,
        errorCount: state.costs.errorCount,
      });
    }

    // GET /analytics/slots
    if (method === "GET" && url === "/analytics/slots") {
      return json(res, 200, { slots: [...state.slots.values()] });
    }

    // GET /analytics/sessions
    if (method === "GET" && url === "/analytics/sessions") {
      const sessions = [...state.slots.values()].map((s) => ({
        sessionId: s.sessionId,
        issueNumber: s.issueNumber,
        slot: s.slot,
        role: s.role,
        startedAt: s.startedAt,
        elapsedMs: s.elapsedMs,
      }));
      return json(res, 200, { sessions });
    }

    // GET /analytics/loops
    if (method === "GET" && url === "/analytics/loops") {
      return json(res, 200, { loops: state.loops });
    }

    // GET /analytics/costs
    if (method === "GET" && url === "/analytics/costs") {
      return json(res, 200, { costs: state.costs });
    }

    // GET /analytics/circuit
    if (method === "GET" && url === "/analytics/circuit") {
      return json(res, 200, {
        tripped: state.loops.dev.circuitTripped,
        consecutiveFailures: state.loops.dev.consecutiveFailures,
      });
    }

    // POST /steer/context
    if (method === "POST" && url === "/steer/context") {
      const body = (await readBody(req)) as {
        session_id?: string;
        context?: string;
      };
      if (!body.session_id || !body.context) {
        return json(res, 400, { error: "session_id and context are required" });
      }
      const active = [...state.slots.values()].some(
        (s) => s.sessionId === body.session_id,
      );
      if (!active) {
        return json(res, 404, {
          accepted: false,
          reason: "session not found in active slots",
        });
      }
      const requestId = randomUUID();
      state.pendingSteers.set(body.session_id, {
        requestId,
        context: body.context,
        queuedAt: Date.now(),
      });
      return json(res, 200, { requestId, accepted: true });
    }

    // POST /steer/escalate
    if (method === "POST" && url === "/steer/escalate") {
      const body = (await readBody(req)) as { issue_number?: number };
      if (!body.issue_number) {
        return json(res, 400, { error: "issue_number is required" });
      }
      const active = [...state.slots.values()].some(
        (s) => s.issueNumber === body.issue_number,
      );
      if (!active) {
        return json(res, 404, {
          accepted: false,
          reason: "issue not currently active in any slot",
        });
      }
      const requestId = randomUUID();
      state.pendingEscalations.set(body.issue_number, {
        requestId,
        queuedAt: Date.now(),
      });
      return json(res, 200, { requestId, accepted: true });
    }

    return json(res, 404, { error: "not found" });
  });

  server.listen(port, host, () => {
    logger.info(`API server listening on http://${host}:${port}`);
  });

  server.on("error", (err) => {
    logger.warn(`API server error: ${err.message}`);
  });
}
```

---

### Task 3 — Wire into `startCommand`

**File:** `packages/cli/commands/start.ts`

Add `--no-api` and `--api-port` flags, create the shared `ApiState`, and start the server:

```typescript
// packages/cli/commands/start.ts

import { ApiState } from "@superfield/core/api-state.js";
import { startApiServer } from "@superfield/core/api-server.js";

export interface StartDeps {
  // ... existing fields ...
  noApi?: boolean;
  apiPort?: number;
}

// In parseStartArgs():
const noApi = args.includes("--no-api");
const portIdx = args.indexOf("--api-port");
const apiPort = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 7837;

// In startCommand(), before Promise.all:
const apiState = new ApiState();

if (!deps.noApi) {
  startApiServer({ port: deps.apiPort ?? 7837, state: apiState, logger });
}

// Pass apiState into loop options so loops can call apiState.record*()
await Promise.all([
  runPlanningLoop({ ...planOpts, apiState }),
  runDevLoop({ ...devOpts, apiState }),
  runDocLoop({ ...docOpts, apiState }),
]);
```

---

### Task 4 — Instrument the dev loop

**File:** `packages/core/loops/dev-loop.ts`

Add `apiState?: ApiState` to `DevLoopOpts`. Splice in record calls at the existing agent spawn/end points and in the heartbeat tick.

```typescript
// Before spawning the agent (~line 563):
opts.apiState?.recordAgentStart({
  slot,
  issueNumber: entry.number,
  role,
  sessionId: pendingSessionId,
  backend: candidate.backend,
  model: candidate.model,
  startedAt: new Date().toISOString(),
});
const startMs = Date.now();

// After agent returns (~line 610):
opts.apiState?.recordAgentEnd(
  slot,
  result.costUsd ?? 0,
  candidate.backend,
  result.isError,
);

// In the heartbeat loop (fires every 60s):
opts.apiState?.recordHeartbeat(slot, Date.now() - startMs);

// Check for pending steer on each heartbeat:
const steer = opts.apiState?.consumeSteer(currentSessionId);
if (steer) {
  logger.info(
    `[slot ${slot}] steering context received (requestId=${steer.requestId})`,
  );
  pendingSteeringContext = steer.context;
}

// Check for pending escalation:
const esc = opts.apiState?.consumeEscalation(entry.number);
if (esc) {
  logger.info(
    `[slot ${slot}] external escalation triggered (requestId=${esc.requestId})`,
  );
  nextEscalated = true;
}

// At end of tick:
opts.apiState?.recordLoopTick(
  "dev",
  Date.now() - tickStartMs,
  tickResult.idle ? tickResult.reason : undefined,
);

// Circuit breaker tripped:
opts.apiState?.recordCircuitTripped(circuit.consecutiveFailures);

// Circuit breaker reset:
opts.apiState?.recordCircuitReset();
```

**Steering context delivery** — when `pendingSteeringContext` is set, write it into the worktree before the next agent continuation so the prompt picks it up:

```typescript
// Before next --continue invocation:
if (pendingSteeringContext) {
  await fs.writeFile(
    join(wt.path, ".superfield/steer.md"),
    pendingSteeringContext,
    "utf8",
  );
  pendingSteeringContext = undefined;
}
// Prompt fragment already checks: "If .superfield/steer.md exists, treat its contents as priority context for this turn."
```

---

### Task 5 — Instrument planning and doc loops

Same pattern as dev loop — add `apiState?: ApiState` to each loop's opts and call `recordLoopTick` at the end of each tick.

**`packages/core/loop.ts`** (planning loop):

```typescript
opts.apiState?.recordLoopTick("plan", Date.now() - tickStartMs, idleReason);
```

**`packages/core/loops/doc-loop.ts`**:

```typescript
opts.apiState?.recordLoopTick("doc", Date.now() - tickStartMs, idleReason);
```

---

### Task 6 — Tests

**`packages/core/__tests__/api-state.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { ApiState } from "../api-state.js";

describe("ApiState", () => {
  it("tracks a slot from start to end", () => {
    const s = new ApiState();
    s.recordAgentStart({
      slot: 1,
      issueNumber: 42,
      role: "primary",
      sessionId: "claude-abc",
      backend: "claude",
      model: "claude-sonnet-4-6",
      startedAt: "2026-01-01T00:00:00Z",
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
    s.recordAgentStart({
      slot: 1,
      issueNumber: 1,
      role: "primary",
      sessionId: "s1",
      backend: "claude",
      model: "m",
      startedAt: "",
    });
    s.recordAgentEnd(1, 0, "claude", true);
    expect(s.costs.errorCount).toBe(1);
  });

  it("consumeSteer returns and removes the pending steer", () => {
    const s = new ApiState();
    s.recordAgentStart({
      slot: 1,
      issueNumber: 1,
      role: "primary",
      sessionId: "claude-xyz",
      backend: "claude",
      model: "m",
      startedAt: "",
    });
    s.pendingSteers.set("claude-xyz", {
      requestId: "r1",
      context: "do this instead",
      queuedAt: Date.now(),
    });
    const steer = s.consumeSteer("claude-xyz");
    expect(steer?.context).toBe("do this instead");
    expect(s.pendingSteers.size).toBe(0);
  });
});
```

**`packages/core/__tests__/api-server.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "http";
import { ApiState } from "../api-state.js";
import { startApiServer } from "../api-server.js";

// Use a throwaway port for tests
const PORT = 17837;
let state: ApiState;

beforeAll(() => {
  state = new ApiState();
  startApiServer({
    port: PORT,
    state,
    logger: { info: () => {}, warn: () => {} } as any,
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
      slot: 1,
      issueNumber: 99,
      role: "primary",
      sessionId: "claude-test",
      backend: "claude",
      model: "claude-sonnet-4-6",
      startedAt: new Date().toISOString(),
    });
    const { body } = await get("/analytics/slots");
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0].issueNumber).toBe(99);
    state.recordAgentEnd(1, 0, "claude", false);
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

  it("accepts and queues steer for active session", async () => {
    state.recordAgentStart({
      slot: 2,
      issueNumber: 55,
      role: "primary",
      sessionId: "claude-live",
      backend: "claude",
      model: "claude-sonnet-4-6",
      startedAt: new Date().toISOString(),
    });
    const { status, body } = await post("/steer/context", {
      session_id: "claude-live",
      context: "pivot to fixing auth",
    });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.requestId).toBeTruthy();
    expect(state.pendingSteers.get("claude-live")?.context).toBe(
      "pivot to fixing auth",
    );
    state.recordAgentEnd(2, 0, "claude", false);
  });
});
```

---

## API Reference

### Analytics Endpoints

| Method | Path                  | Description                                                 |
| ------ | --------------------- | ----------------------------------------------------------- |
| GET    | `/health`             | Liveness check                                              |
| GET    | `/analytics/status`   | High-level summary (active slots, loop health, cost totals) |
| GET    | `/analytics/slots`    | Active agent slots with session IDs and elapsed time        |
| GET    | `/analytics/sessions` | Same data shaped by session                                 |
| GET    | `/analytics/loops`    | Per-loop last-tick time and idle reason                     |
| GET    | `/analytics/costs`    | Cost accumulation total and by backend                      |
| GET    | `/analytics/circuit`  | Dev-loop circuit breaker state                              |

### Steering Endpoints

| Method | Path              | Body                      | Description                                        |
| ------ | ----------------- | ------------------------- | -------------------------------------------------- |
| POST   | `/steer/context`  | `{ session_id, context }` | Inject context string into a running agent session |
| POST   | `/steer/escalate` | `{ issue_number }`        | Trigger blueprint escalation for an active issue   |

### Example

```bash
# Find the active session
curl -s http://localhost:7837/analytics/sessions | jq '.sessions[0].sessionId'
# "claude-abc123"

# Inject steering context
curl -s -X POST http://localhost:7837/steer/context \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"claude-abc123","context":"Auth service broke — fix the mock before writing new tests."}'
# { "requestId": "...", "accepted": true }
```

---

## Configuration

| CLI flag       | Env var               | Default   | Description            |
| -------------- | --------------------- | --------- | ---------------------- |
| `--no-api`     | `SUPERFIELD_NO_API=1` | off       | Disable the API server |
| `--api-port N` | `SUPERFIELD_API_PORT` | 7837      | Port to listen on      |
| `--api-host H` | `SUPERFIELD_API_HOST` | 127.0.0.1 | Bind address           |

---

## File Layout

```
packages/
├── cli/
│   └── commands/start.ts        # add --no-api / --api-port; create ApiState; start server
└── core/
    ├── api-state.ts             # NEW: shared in-memory state + mutators
    ├── api-server.ts            # NEW: HTTP server (zero new deps)
    ├── loops/dev-loop.ts        # instrument with recordAgent*, recordLoopTick, consume*
    ├── loop.ts                  # instrument with recordLoopTick
    └── loops/doc-loop.ts        # instrument with recordLoopTick
```
