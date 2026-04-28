/**
 * @file deploy.ts
 *
 * Deployment health endpoints (D1 / C-9.5).
 *
 * Routes:
 *   GET  /studio/deploy/envs            — list envs derived from DEPLOY_HOST_<ENV> variables
 *   GET  /studio/deploy/doctor/:env     — run doctor() for an env, return checks[]
 *   GET  /studio/deploy/secrets/:env    — presence audit for required secrets/vars
 *   GET  /studio/deploy/ci              — latest workflow runs on main for deploy-<env>
 *   POST /studio/deploy/rollback/:env   — SSE log of rollbackEnv() (requires { confirm: true })
 *
 * All failure paths return the standard `errorEnvelope` shape; tests assert
 * the demo can degrade gracefully when GitHub credentials are absent.
 */

import { doctor } from "../../core/commands/doctor.ts";
import { errorResponse } from "../lib/error-envelope";
import { logBackendError } from "./debug-events";
import { REPO_ROOT } from "./agent";

const DEFAULT_ENVS = ["dev", "staging", "prod"] as const;
const SECRET_NAMES = (env: string): readonly string[] => {
  const e = env.toUpperCase();
  return [`DEPLOY_HOST_${e}`, `DEPLOY_KEY_${e}`, `DATABASE_URL_${e}`];
};

interface ResolvedRepo {
  readonly repo: string | null;
  readonly token: string | null;
}

async function resolveRepo(): Promise<ResolvedRepo> {
  let repo: string | null = null;
  try {
    const proc = Bun.spawn(["git", "config", "--get", "remote.origin.url"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const url = out.trim();
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (m) repo = `${m[1]}/${m[2]}`;
  } catch (err) {
    logBackendError(err, "deploy.resolveRepo");
  }

  let token: string | null = null;
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const trimmed = out.trim();
    if (trimmed) token = trimmed;
  } catch {
    // gh CLI absent — token stays null
  }

  return { repo, token };
}

interface VariableListItem {
  readonly name: string;
  readonly value: string;
}

async function ghFetchJson<T>(
  path: string,
  token: string,
): Promise<{ status: number; data: T | null }> {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return { status: res.status, data: null };
  const text = await res.text();
  if (!text) return { status: res.status, data: null };
  return { status: res.status, data: JSON.parse(text) as T };
}

/** GET /studio/deploy/envs */
async function handleEnvs(): Promise<Response> {
  const { repo, token } = await resolveRepo();
  if (!repo || !token) {
    return jsonOk({ envs: [...DEFAULT_ENVS], source: "fallback" });
  }
  try {
    const { data } = await ghFetchJson<{ variables: VariableListItem[] }>(
      `/repos/${repo}/actions/variables?per_page=100`,
      token,
    );
    const envs = new Set<string>();
    for (const v of data?.variables ?? []) {
      const m = v.name.match(/^DEPLOY_HOST_(.+)$/);
      if (m?.[1]) envs.add(m[1].toLowerCase());
    }
    if (envs.size === 0) {
      return jsonOk({ envs: [...DEFAULT_ENVS], source: "fallback" });
    }
    return jsonOk({ envs: [...envs].sort(), source: "github" });
  } catch (err) {
    logBackendError(err, "GET /studio/deploy/envs");
    return jsonOk({ envs: [...DEFAULT_ENVS], source: "fallback" });
  }
}

/** GET /studio/deploy/doctor/:env */
async function handleDoctor(env: string): Promise<Response> {
  const { repo } = await resolveRepo();
  if (!repo) {
    return errorResponse({
      code: "validation",
      message: "Cannot determine repository",
      hint: "Run from inside a git checkout with a github.com origin remote.",
    });
  }
  try {
    const report = await doctor({ repo, env });
    return jsonOk({
      env,
      checks: report.checks,
      allOk: report.allOk,
    });
  } catch (err) {
    logBackendError(err, `GET /studio/deploy/doctor/${env}`);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse({
      code: "server",
      message: `doctor() failed: ${message}`,
      hint: "Check the studio debug view for the stack trace.",
    });
  }
}

/** GET /studio/deploy/secrets/:env */
async function handleSecrets(env: string): Promise<Response> {
  const required = SECRET_NAMES(env);
  const { repo, token } = await resolveRepo();
  if (!repo || !token) {
    return jsonOk({
      env,
      checks: required.map((name) => ({
        name,
        present: false,
        detail: "GitHub credentials unavailable; cannot verify",
      })),
    });
  }
  try {
    const [secretsRes, varsRes] = await Promise.all([
      ghFetchJson<{ secrets?: { name: string }[] }>(
        `/repos/${repo}/actions/secrets?per_page=100`,
        token,
      ),
      ghFetchJson<{ variables?: { name: string }[] }>(
        `/repos/${repo}/actions/variables?per_page=100`,
        token,
      ),
    ]);
    const known = new Set<string>();
    for (const s of secretsRes.data?.secrets ?? []) known.add(s.name);
    for (const v of varsRes.data?.variables ?? []) known.add(v.name);
    return jsonOk({
      env,
      checks: required.map((name) => ({
        name,
        present: known.has(name),
        detail: known.has(name) ? "Defined" : "Not set on this repository",
      })),
    });
  } catch (err) {
    logBackendError(err, `GET /studio/deploy/secrets/${env}`);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse({
      code: "upstream",
      message: `Failed to query GitHub: ${message}`,
      hint: "Verify `gh auth status` and your network connection.",
    });
  }
}

interface WorkflowRunSummary {
  readonly env: string;
  readonly workflow: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
  readonly createdAt: string;
}

interface RunsResponse {
  readonly workflow_runs?: ReadonlyArray<{
    readonly name?: string;
    readonly path?: string;
    readonly status?: string;
    readonly conclusion?: string | null;
    readonly html_url?: string;
    readonly created_at?: string;
  }>;
}

/** GET /studio/deploy/ci */
async function handleCi(): Promise<Response> {
  const { repo, token } = await resolveRepo();
  if (!repo || !token) {
    return jsonOk({ runs: [], source: "unavailable" });
  }
  try {
    const { data } = await ghFetchJson<RunsResponse>(
      `/repos/${repo}/actions/runs?branch=main&per_page=20`,
      token,
    );
    const runs: WorkflowRunSummary[] = [];
    for (const r of data?.workflow_runs ?? []) {
      const path = r.path ?? "";
      const m = path.match(/deploy-([a-z0-9_-]+)\.ya?ml/i);
      if (!m?.[1]) continue;
      runs.push({
        env: m[1].toLowerCase(),
        workflow: r.name ?? path,
        status: r.status ?? "unknown",
        conclusion: r.conclusion ?? null,
        url: r.html_url ?? `https://github.com/${repo}/actions`,
        createdAt: r.created_at ?? "",
      });
    }
    // Keep only the latest per env.
    const latest = new Map<string, WorkflowRunSummary>();
    for (const run of runs) {
      const prev = latest.get(run.env);
      if (!prev || run.createdAt > prev.createdAt) latest.set(run.env, run);
    }
    return jsonOk({ runs: [...latest.values()], source: "github" });
  } catch (err) {
    logBackendError(err, "GET /studio/deploy/ci");
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse({
      code: "upstream",
      message: `Failed to list workflow runs: ${message}`,
      hint: "Verify GitHub credentials and network access.",
    });
  }
}

interface RollbackJob {
  readonly id: string;
  readonly env: string;
  readonly lines: string[];
  done: boolean;
  status: "running" | "ok" | "error";
  finalMessage: string;
  subscribers: Set<(line: string) => void>;
  finalSubscribers: Set<(status: "ok" | "error", msg: string) => void>;
}

const rollbackJobs = new Map<string, RollbackJob>();

function newJobId(): string {
  return `rb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Start a rollback dry-run job. The full `rollbackEnv()` flow needs a
 * mnemonic, deploy host, SSH key, and namespace — none of which are wired up
 * for the demo. The synthetic log faithfully describes each step the real
 * runner would perform so the demo screen is meaningful.
 */
function startRollbackJob(env: string): RollbackJob {
  const job: RollbackJob = {
    id: newJobId(),
    env,
    lines: [],
    done: false,
    status: "running",
    finalMessage: "",
    subscribers: new Set(),
    finalSubscribers: new Set(),
  };
  rollbackJobs.set(job.id, job);

  const append = (line: string): void => {
    job.lines.push(line);
    for (const fn of job.subscribers) fn(line);
  };
  const finish = (status: "ok" | "error", message: string): void => {
    job.done = true;
    job.status = status;
    job.finalMessage = message;
    for (const fn of job.finalSubscribers) fn(status, message);
  };

  const ts = (): string => new Date().toISOString();
  setTimeout(() => append(`[${ts()}] rollback request accepted env=${env}`), 0);
  setTimeout(() => append(`[${ts()}] resolving deployment configuration`), 50);
  setTimeout(
    () =>
      append(
        `[${ts()}] rollbackEnv() requires DEPLOY_HOST_${env.toUpperCase()} variable + mnemonic; running in dry-run mode`,
      ),
    100,
  );
  setTimeout(
    () => append(`[${ts()}] dry-run: would invoke kubectl rollout undo`),
    150,
  );
  setTimeout(
    () => finish("ok", `rollback dry-run complete for env=${env}`),
    200,
  );

  return job;
}

/** POST /studio/deploy/rollback/:env — start a job, return { jobId } */
async function handleRollback(req: Request, env: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { confirm?: boolean };
  if (body.confirm !== true) {
    return errorResponse({
      code: "validation",
      message: "Rollback requires explicit confirmation",
      hint: "POST { confirm: true } to /studio/deploy/rollback/:env.",
    });
  }
  const job = startRollbackJob(env);
  return jsonOk({ jobId: job.id, env });
}

/** GET /studio/deploy/rollback-log?job=<id> — SSE stream of job lines */
function handleRollbackLog(url: URL): Response {
  const id = url.searchParams.get("job");
  if (!id) {
    return errorResponse({
      code: "validation",
      message: "job query parameter is required",
      hint: "Pass ?job=<jobId> returned by POST /studio/deploy/rollback/:env.",
    });
  }
  const job = rollbackJobs.get(id);
  if (!job) {
    return errorResponse({
      code: "not_found",
      message: `Unknown rollback job: ${id}`,
      hint: "Jobs expire when the studio process restarts.",
    });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendData = (line: string): void => {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      };
      // Replay buffered lines.
      for (const line of job.lines) sendData(line);
      if (job.done) {
        const event = job.status === "ok" ? "done" : "error";
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${job.finalMessage}\n\n`),
        );
        controller.close();
        return;
      }
      const onLine = (line: string): void => sendData(line);
      const onFinal = (status: "ok" | "error", message: string): void => {
        const event = status === "ok" ? "done" : "error";
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${message}\n\n`),
        );
        job.subscribers.delete(onLine);
        job.finalSubscribers.delete(onFinal);
        controller.close();
      };
      job.subscribers.add(onLine);
      job.finalSubscribers.add(onFinal);
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

/** Test seam — clear all in-memory rollback jobs. */
export function _resetRollbackJobs(): void {
  rollbackJobs.clear();
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Top-level deploy route handler. Returns null when the request does not
 * belong to /studio/deploy/* so router.ts can fall through to other handlers.
 */
export async function handleDeployRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;
  if (
    !pathname.startsWith("/studio/deploy/") &&
    pathname !== "/studio/deploy"
  ) {
    return null;
  }
  const method = req.method;

  if (method === "GET" && pathname === "/studio/deploy/envs") {
    return handleEnvs();
  }
  if (method === "GET" && pathname === "/studio/deploy/ci") {
    return handleCi();
  }
  if (method === "GET" && pathname === "/studio/deploy/rollback-log") {
    return handleRollbackLog(url);
  }

  const doctorMatch = pathname.match(/^\/studio\/deploy\/doctor\/([^/]+)$/);
  if (method === "GET" && doctorMatch?.[1]) {
    return handleDoctor(decodeURIComponent(doctorMatch[1]));
  }

  const secretsMatch = pathname.match(/^\/studio\/deploy\/secrets\/([^/]+)$/);
  if (method === "GET" && secretsMatch?.[1]) {
    return handleSecrets(decodeURIComponent(secretsMatch[1]));
  }

  const rollbackMatch = pathname.match(/^\/studio\/deploy\/rollback\/([^/]+)$/);
  if (method === "POST" && rollbackMatch?.[1]) {
    return handleRollback(req, decodeURIComponent(rollbackMatch[1]));
  }

  return errorResponse({
    code: "not_found",
    message: `No deploy route for ${method} ${pathname}`,
    hint: "See packages/control/src/deploy.ts for the route table.",
  });
}
