import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
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

export function startApiServer(
  opts: ApiServerOpts,
): ReturnType<typeof createServer> {
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

    // POST /studio/run — SSE stream of a Claude agent turn
    if (method === "POST" && url === "/studio/run") {
      const body = (await readBody(req)) as {
        message?: string;
        repoRoot?: string;
        sessionKey?: string;
        allowedTools?: string;
        mode?: string;
      };

      if (!body.message) {
        return json(res, 400, { error: "message is required" });
      }

      const sessionId = randomUUID();
      const repoRoot = body.repoRoot ?? process.cwd();
      const allowedTools = body.allowedTools ?? "Read,Edit,Write,Bash,Glob,Grep";
      const args = [
        "claude", "-p", body.message,
        "--dangerously-skip-permissions",
        "--allowedTools", allowedTools,
      ];
      if (body.sessionKey) {
        args.push("--session-key", body.sessionKey);
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      // Emit session ID before any content chunks.
      res.write(`event: session\ndata: ${JSON.stringify({ sessionId })}\n\n`);

      let proc: ReturnType<typeof Bun.spawn> | undefined;
      try {
        proc = Bun.spawn(args, {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          // Pass process.env at spawn time so PATH mutations in tests are respected.
          env: { ...process.env },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.write(`event: error\ndata: ${JSON.stringify(msg)}\n\n`);
        res.end();
        return;
      }

      // Stream stdout chunks as SSE data events.
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Prefix each line with "data: " for proper SSE formatting.
          for (const line of chunk.split("\n")) {
            res.write(`data: ${line}\n`);
          }
          res.write("\n");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.write(`event: error\ndata: ${JSON.stringify(msg)}\n\n`);
        res.end();
        return;
      }

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        res.write(`event: error\ndata: ${JSON.stringify(`claude exited with code ${exitCode}`)}\n\n`);
      } else {
        res.write(`event: done\ndata: ${JSON.stringify({ filesChanged: [] })}\n\n`);
      }
      res.end();
      return;
    }

    return json(res, 404, { error: "not found" });
  });

  server.listen(port, host, () => {
    logger.emit("info", `API server listening on http://${host}:${port}`);
  });

  server.on("error", (err: Error) => {
    logger.emit("warn", `API server error: ${err.message}`);
  });

  return server;
}
