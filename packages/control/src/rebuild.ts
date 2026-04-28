/**
 * @file rebuild.ts
 *
 * Background rebuild job: runs `docker build` + `k3d image import` +
 * `kubectl rollout restart` without blocking the event loop.
 *
 * Routes (registered in router.ts):
 *   POST /studio/rebuild          — start a job → { jobId }
 *   GET  /studio/rebuild/log?job= — SSE stream of build output
 *
 * Each line of stdout/stderr is forwarded as an SSE data event. A terminal
 * `event: done` or `event: error` signals completion. Late subscribers
 * receive a replay of all buffered lines before the terminal event.
 */

import { spawn } from "child_process";
import { logBackendError } from "./debug-events";
import { errorResponse } from "../lib/error-envelope";
import type { ControlConfig } from "./config";

export interface RebuildJob {
  readonly id: string;
  readonly lines: string[];
  done: boolean;
  status: "running" | "ok" | "error";
  finalMessage: string;
  readonly subscribers: Set<(line: string) => void>;
  readonly finalSubscribers: Set<(status: "ok" | "error", msg: string) => void>;
}

const jobs = new Map<string, RebuildJob>();

function newJobId(): string {
  return `rb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run a command, calling onLine for each stdout/stderr line.
 * Resolves with the exit code.
 */
function runCommand(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let buf = "";
    const handleData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (line) onLine(line);
      }
    };

    proc.stdout.on("data", handleData);
    proc.stderr.on("data", handleData);

    proc.on("close", (code) => {
      if (buf) onLine(buf);
      resolve(code ?? 1);
    });

    proc.on("error", (err) => {
      onLine(`[error] ${err.message}`);
      resolve(1);
    });
  });
}

/**
 * Start a rebuild job asynchronously. Returns the job immediately;
 * docker build runs in the background.
 */
export function startRebuildJob(config: ControlConfig): RebuildJob {
  const job: RebuildJob = {
    id: newJobId(),
    lines: [],
    done: false,
    status: "running",
    finalMessage: "",
    subscribers: new Set(),
    finalSubscribers: new Set(),
  };
  jobs.set(job.id, job);

  const append = (line: string): void => {
    job.lines.push(line);
    for (const fn of job.subscribers) fn(line);
  };

  const finish = (status: "ok" | "error", message: string): void => {
    (job as { done: boolean }).done = true;
    (job as { status: string }).status = status;
    (job as { finalMessage: string }).finalMessage = message;
    for (const fn of job.finalSubscribers) fn(status, message);
    setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000);
  };

  const sourceDir =
    process.env.CONTROL_SOURCE_DIR ??
    process.env.SUPERFIELD_REPO_ROOT ??
    process.cwd();

  void runRebuild(sourceDir, config, append, finish);

  return job;
}

async function runRebuild(
  sourceDir: string,
  config: ControlConfig,
  append: (line: string) => void,
  finish: (status: "ok" | "error", msg: string) => void,
): Promise<void> {
  const dockerfile = `${sourceDir}/Dockerfile.release`;
  const tag = "superfield-release:studio";

  append(`[rebuild] starting docker build — ${tag}`);
  append(`[rebuild] source: ${sourceDir}`);

  try {
    // ── docker build ────────────────────────────────────────────────────────
    const buildExit = await runCommand(
      "docker",
      ["build", "-f", dockerfile, "-t", tag, sourceDir],
      append,
    );
    if (buildExit !== 0) {
      const msg = `docker build exited ${buildExit}`;
      append(`[rebuild] ✗ ${msg}`);
      logBackendError(new Error(msg), "POST /studio/rebuild");
      finish("error", msg);
      return;
    }
    append(`[rebuild] ✓ docker build complete`);

    // ── k3d image import ────────────────────────────────────────────────────
    append(`[rebuild] importing ${tag} into k3d cluster…`);
    const k3dExit = await runCommand(
      "k3d",
      ["image", "import", tag],
      append,
    );
    if (k3dExit !== 0) {
      const msg = `k3d image import exited ${k3dExit}`;
      append(`[rebuild] ✗ ${msg}`);
      finish("error", msg);
      return;
    }
    append(`[rebuild] ✓ image imported`);

    // ── kubectl rollout restart ─────────────────────────────────────────────
    append(`[rebuild] restarting deployments…`);
    const kubectlExit = await runCommand(
      "kubectl",
      [
        "--context",
        config.clusterContext,
        "rollout",
        "restart",
        "deployment",
        "--all",
        `--namespace=${config.clusterContext}`,
      ],
      append,
    );
    if (kubectlExit !== 0) {
      const msg = `kubectl rollout restart exited ${kubectlExit}`;
      append(`[rebuild] ✗ ${msg}`);
      finish("error", msg);
      return;
    }
    append(`[rebuild] ✓ deployments restarted`);
    finish("ok", "Rebuild complete — cluster is updating.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    append(`[rebuild] ✗ unexpected error: ${msg}`);
    logBackendError(err, "POST /studio/rebuild");
    finish("error", msg);
  }
}

/** POST /studio/rebuild */
export function handleRebuildStart(
  _req: Request,
  config: ControlConfig,
): Response {
  const job = startRebuildJob(config);
  return new Response(JSON.stringify({ ok: true, jobId: job.id }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

/** GET /studio/rebuild/log?job=<id> */
export function handleRebuildLog(url: URL): Response {
  const id = url.searchParams.get("job");
  if (!id) {
    return errorResponse({
      code: "validation",
      message: "job query parameter is required",
      hint: "Pass ?job=<jobId> from the POST /studio/rebuild response.",
    });
  }
  const job = jobs.get(id);
  if (!job) {
    return errorResponse({
      code: "not_found",
      message: `Unknown rebuild job: ${id}`,
      hint: "Jobs expire 10 minutes after completion or on server restart.",
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendData = (line: string): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      };
      for (const line of job.lines) sendData(line);
      if (job.done) {
        const event = job.status === "ok" ? "done" : "error";
        controller.enqueue(
          encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(job.finalMessage)}\n\n`,
          ),
        );
        controller.close();
        return;
      }
      const onLine = (line: string): void => sendData(line);
      const onFinal = (status: "ok" | "error", message: string): void => {
        const event = status === "ok" ? "done" : "error";
        controller.enqueue(
          encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(message)}\n\n`,
          ),
        );
        job.subscribers.delete(onLine);
        job.finalSubscribers.delete(onFinal);
        controller.close();
      };
      job.subscribers.add(onLine);
      job.finalSubscribers.add(onFinal);
    },
    cancel() {
      // Client disconnected — job continues in background.
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

/** Test seam. */
export function _clearRebuildJobs(): void {
  jobs.clear();
}
