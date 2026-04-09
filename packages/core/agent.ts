import { spawn } from "node:child_process";

export type AgentBackend = "claude" | "codex";
export type AgentMode = AgentBackend | "auto";

// Shape of the JSON object Claude Code emits with --output-format json
interface ClaudeJsonResult {
  type: string;
  subtype: string;
  is_error: boolean;
  session_id: string;
  result?: string;
  error?: string;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface AgentOpts {
  /** Absolute path to the git worktree the agent should work in. */
  worktreePath: string;
  /** The prompt to send. */
  prompt: string;
  /** If set, resumes this session rather than starting a new one. */
  sessionId?: string;
  /** Override the default model. */
  model?: string;
  /** Override the default max turns (Claude only; default: 50). */
  maxTurns?: number;
  /** Explicit backend override. Defaults to the env setting or auto. */
  provider?: AgentMode;
}

export interface AgentResult {
  /** The session ID returned by the agent — persist this to resume later. */
  sessionId: string;
  /** Final text output from the agent. */
  output: string;
  /** True if the agent reported an execution error. */
  isError: boolean;
  /** Approximate cost in USD, if reported. */
  costUsd?: number;
  /**
   * Set by agent to request expanded blueprint context on next turn (issue #80).
   */
  needsBlueprintEscalation?: boolean;
}

class AgentRateLimitError extends Error {
  constructor(
    readonly backend: AgentBackend,
    message: string,
  ) {
    super(message);
    this.name = "AgentRateLimitError";
  }
}

/**
 * Spawns the configured agent CLI in headless mode and returns the session ID and output.
 *
 * The caller is responsible for persisting `result.sessionId` so that the next
 * invocation for the same slot can resume where this one left off.
 */
export async function spawnAgent(opts: AgentOpts): Promise<AgentResult> {
  const backend = resolveBackend(opts.provider);
  try {
    return await spawnAgentBackend(backend, opts);
  } catch (err) {
    if (backend === "claude" && isRetryableRateLimitError(err)) {
      return spawnAgentBackend("codex", { ...opts, sessionId: undefined });
    }
    throw err;
  }
}

function resolveBackend(provider?: AgentMode): AgentBackend {
  const env = process.env.SUPERFIELD_AGENT_PROVIDER?.trim().toLowerCase();
  if (env === "claude" || env === "codex" || env === "auto") {
    return env === "codex" ? "codex" : "claude";
  }
  return provider === "codex" ? "codex" : "claude";
}

async function spawnAgentBackend(
  backend: AgentBackend,
  opts: AgentOpts,
): Promise<AgentResult> {
  const run = await runCli(
    backend === "claude" ? "claude" : "codex",
    buildArgs(backend, opts),
    opts.worktreePath,
  );

  if (backend === "claude") {
    return parseClaudeRun(run);
  }

  return parseCodexRun(run);
}

function buildArgs(backend: AgentBackend, opts: AgentOpts): string[] {
  if (backend === "claude") {
    const args: string[] = [
      "--print",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--max-turns",
      String(opts.maxTurns ?? 50),
    ];

    if (opts.model) {
      args.push("--model", opts.model);
    }

    if (opts.sessionId) {
      args.push("--resume", opts.sessionId);
    }

    args.push(opts.prompt);
    return args;
  }

  const args: string[] = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-C",
    opts.worktreePath,
  ];

  if (!opts.sessionId) {
    args.splice(2, 0, "--ephemeral");
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.sessionId) {
    args.push("resume", opts.sessionId, opts.prompt);
  } else {
    args.push(opts.prompt);
  }

  return args;
}

async function runCli(
  command: string,
  args: string[],
  cwd: string,
): Promise<CliRunResult> {
  return new Promise<CliRunResult>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    proc.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
      });
    });
  });
}

function parseClaudeRun(run: CliRunResult): AgentResult {
  let parsed: ClaudeJsonResult;
  try {
    parsed = JSON.parse(run.stdout) as ClaudeJsonResult;
  } catch {
    if (isRetryableRateLimit(run.stdout) || isRetryableRateLimit(run.stderr)) {
      throw new AgentRateLimitError(
        "claude",
        `claude was rate limited: ${truncateForError(run.stderr || run.stdout)}`,
      );
    }
    throw new Error(
      `claude exited with code ${run.code} and produced non-JSON output.\n` +
        `stdout: ${run.stdout.slice(0, 500)}\n` +
        `stderr: ${run.stderr.slice(0, 500)}`,
    );
  }

  if (!parsed.session_id) {
    if (
      isRetryableRateLimit(parsed.error ?? "") ||
      isRetryableRateLimit(run.stderr)
    ) {
      throw new AgentRateLimitError(
        "claude",
        `claude was rate limited: ${truncateForError(parsed.error ?? run.stderr)}`,
      );
    }
    throw new Error(
      `claude response missing session_id: ${run.stdout.slice(0, 500)}`,
    );
  }

  const output = parsed.result ?? parsed.error ?? "";
  if (parsed.is_error && isRetryableRateLimit(output)) {
    throw new AgentRateLimitError(
      "claude",
      `claude was rate limited: ${truncateForError(output)}`,
    );
  }

  return {
    sessionId: parsed.session_id,
    output,
    isError: parsed.is_error,
    costUsd: parsed.cost_usd,
  };
}

function parseCodexRun(run: CliRunResult): AgentResult {
  const lines = run.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  let sessionId = "";
  let output = "";
  let isError = false;
  let costUsd: number | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `codex exited with code ${run.code} and produced non-JSONL output.\n` +
          `stdout: ${run.stdout.slice(0, 500)}\n` +
          `stderr: ${run.stderr.slice(0, 500)}`,
      );
    }

    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (
      record.type === "thread.started" &&
      typeof record.thread_id === "string"
    ) {
      sessionId = record.thread_id;
      continue;
    }
    if (record.type === "item.completed") {
      const item = record.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message") {
        output = readTextField(item);
      } else if (item?.type === "error") {
        isError = true;
        output = readTextField(item);
      }
      continue;
    }
    if (record.type === "error") {
      isError = true;
      output = readTextField(record);
      continue;
    }
  }

  if (!sessionId) {
    if (isRetryableRateLimit(run.stdout) || isRetryableRateLimit(run.stderr)) {
      throw new AgentRateLimitError(
        "codex",
        `codex was rate limited: ${truncateForError(run.stderr || run.stdout)}`,
      );
    }
    throw new Error(
      `codex response missing thread_id: ${run.stdout.slice(0, 500)}\nstderr: ${run.stderr.slice(0, 500)}`,
    );
  }

  return { sessionId, output, isError, costUsd };
}

function readTextField(obj: Record<string, unknown>): string {
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.error === "string") return obj.error;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.result === "string") return obj.result;
  return "";
}

function isRetryableRateLimit(value: string): boolean {
  return /rate limit|rate-limit|429|too many requests|quota exceeded|temporarily unavailable|throttl/i.test(
    value,
  );
}

function isRetryableRateLimitError(err: unknown): boolean {
  if (err instanceof AgentRateLimitError) return true;
  if (err instanceof Error) return isRetryableRateLimit(err.message);
  return false;
}

function truncateForError(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}
