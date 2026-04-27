/**
 * @file orchestrator.ts
 *
 * Orchestrator HTTP endpoints — manage the superfield dev loop process.
 *
 * Routes:
 *   GET  /orchestrator/status  — { process, pid, apiReachable, uptimeMs }
 *   POST /orchestrator/start   — spawn dev loop { repo, slotCount }
 *   POST /orchestrator/stop    — SIGTERM the managed process
 *   GET  /orchestrator/logs    — SSE stream of stdout/stderr ring buffer + live tail
 */

import { DevLoopProcess } from "./dev-loop-process";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Module-level singleton — created lazily on first request.
let _devLoop: DevLoopProcess | null = null;
let startedAt: number | null = null;
const logSubscribers: Set<(line: string) => void> = new Set();

function getDevLoop(apiUrl: string): DevLoopProcess {
  if (!_devLoop) {
    _devLoop = new DevLoopProcess({
      apiUrl,
      onStateChange: (_state) => {
        /* state change recorded via status() */
      },
      onLog: (line) => {
        for (const sub of logSubscribers) sub(line);
      },
    });
  }
  return _devLoop;
}

export async function handleOrchestratorRequest(
  req: Request,
  url: URL,
  superfieldApiUrl: string,
): Promise<Response | null> {
  const { pathname } = url;
  const method = req.method;

  if (!pathname.startsWith("/orchestrator/")) return null;

  const loop = getDevLoop(superfieldApiUrl);

  // GET /orchestrator/status
  if (method === "GET" && pathname === "/orchestrator/status") {
    const apiReachable = await loop.isApiReachable();
    const uptimeMs = startedAt ? Date.now() - startedAt : 0;
    return json({
      process: loop.status(),
      pid: loop.pid() ?? null,
      apiReachable,
      uptimeMs,
    });
  }

  // POST /orchestrator/start
  if (method === "POST" && pathname === "/orchestrator/start") {
    const body = (await req.json().catch(() => ({}))) as {
      repo?: string;
      slotCount?: number;
    };
    if (!body.repo) {
      return json({ ok: false, reason: "repo is required" }, 400);
    }
    const current = loop.status();
    if (current === "running" || current === "starting") {
      return json({ ok: false, reason: `dev loop is already ${current}` }, 409);
    }
    startedAt = Date.now();
    void loop.spawn(body.repo, { slotCount: body.slotCount });
    return json({ ok: true, pid: loop.pid() ?? null });
  }

  // POST /orchestrator/stop
  if (method === "POST" && pathname === "/orchestrator/stop") {
    await loop.stop();
    startedAt = null;
    return json({ ok: true });
  }

  // GET /orchestrator/logs — SSE stream of ring buffer + live tail
  if (method === "GET" && pathname === "/orchestrator/logs") {
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit buffered logs first.
        for (const line of loop.logs()) {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }

        // Subscribe to new log lines.
        function onLine(line: string) {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }

        logSubscribers.add(onLine);

        // Clean up on stream cancel (browser disconnect).
        return () => {
          logSubscribers.delete(onLine);
        };
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  return null;
}

/** Reset the singleton (for tests). */
export function _resetDevLoop(): void {
  _devLoop = null;
  startedAt = null;
  logSubscribers.clear();
}

/** Inject a pre-constructed DevLoopProcess (for tests). */
export function _setDevLoop(loop: DevLoopProcess): void {
  _devLoop = loop;
}
