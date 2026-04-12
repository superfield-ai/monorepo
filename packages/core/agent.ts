import { spawn } from "node:child_process";
import { writeToLog } from "./file-logger.ts";

export type AgentBackend = "claude" | "codex";
export type AgentMode = AgentBackend | "auto";
export type AgentLoop = "plan" | "dev" | "doc";

type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

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

interface AgentLogger {
  emit: (level: LogLevel, message: string) => void;
  currentLevel: LogLevel;
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
  /** Optional loop context for logging (plan/dev/doc). */
  loop?: AgentLoop;
  /** Task type for logging (e.g. "feature", "dev-scout", "ci-failure"). */
  task?: string;
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
   * Escalation signal from the agent (#78). When true, the next turn's
   * dev-loop prompt will layer in domain-filtered `principle` + `threat`
   * rules on top of the first-turn narrow context (implementation +
   * antipattern). Escalation is one-shot — once expanded, context stays
   * expanded for the remainder of the issue and the flag is not consulted
   * again. Agents should set this only when they have insufficient
   * context to implement confidently.
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

export class StaleSessionError extends Error {
  constructor(
    readonly sessionId: string,
    readonly backend: AgentBackend,
  ) {
    super(`Session ${sessionId} not found on ${backend} — session is stale`);
    this.name = "StaleSessionError";
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
  const logger = makeAgentLogger(opts.loop);
  try {
    return await spawnAgentBackend(backend, opts, logger);
  } catch (err) {
    if (backend === "claude" && isRetryableRateLimitError(err)) {
      logger.emit(
        "warn",
        "rate limited; falling back to codex for this run",
      );
      const mappedModel = mapClaudeModelAliasToCodex(opts.model, logger);
      try {
        return await spawnAgentBackend(
          "codex",
          { ...opts, sessionId: undefined, model: mappedModel },
          logger,
        );
      } catch (fallbackErr) {
        if (mappedModel && isUnsupportedModelError(fallbackErr)) {
          logger.emit(
            "warn",
            `codex rejected model ${mappedModel}; retrying with codex default model`,
          );
          return spawnAgentBackend(
            "codex",
            { ...opts, sessionId: undefined, model: undefined },
            logger,
          );
        }
        throw fallbackErr;
      }
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
  logger: AgentLogger,
): Promise<AgentResult> {
  logInvocationStart(backend, opts, logger);
  const startMs = Date.now();
  const issueNumber = extractIssueNumber(opts.prompt);
  const issuePart = issueNumber === null ? "" : ` issue=#${issueNumber}`;
  const taskPart = opts.task ? ` task=${opts.task}` : "";
  const heartbeat = setInterval(() => {
    const elapsedS = Math.round((Date.now() - startMs) / 1000);
    logger.emit(
      "info",
      `agent still running${issuePart}${taskPart} elapsed=${elapsedS}s backend=${backend}`,
    );
  }, 60_000);
  let run: CliRunResult;
  try {
    run = await runCli(
      backend === "claude" ? "claude" : "codex",
      buildArgs(backend, opts, logger),
      opts.worktreePath,
      logger,
    );
  } finally {
    clearInterval(heartbeat);
  }
  logRawCliResult(backend, run, logger);

  if (backend === "claude") {
    return parseClaudeRun(run, logger);
  }

  return parseCodexRun(run, logger);
}

function buildArgs(
  backend: AgentBackend,
  opts: AgentOpts,
  logger: AgentLogger,
): string[] {
  if (backend === "claude") {
    const args: string[] = [
      "--print",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--max-turns",
      String(opts.maxTurns ?? 50),
    ];

    args.push("--effort", "medium");

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

  const codexModel = normalizeCodexModel(opts.model, logger);
  if (codexModel) {
    args.push("--model", codexModel);
  }

  if (opts.sessionId) {
    args.push("resume", opts.sessionId, opts.prompt);
  } else {
    args.push(opts.prompt);
  }

  return args;
}

function normalizeCodexModel(
  model: string | undefined,
  logger: AgentLogger,
): string | undefined {
  if (!model) return undefined;
  return model;
}

function mapClaudeModelAliasToCodex(
  model: string | undefined,
  logger: AgentLogger,
): string | undefined {
  if (!model) return undefined;
  const normalized = model.trim().toLowerCase();
  let mapped: string | undefined;
  if (normalized === "haiku") mapped = "gpt-5.4-mini";
  else if (normalized === "sonnet") mapped = "gpt-5.4";
  else if (normalized === "opus") mapped = "gpt-5.4";
  if (!mapped) return model;
  logger.emit(
    "info",
    `codex fallback model mapping: ${model} -> ${mapped}`,
  );
  return mapped;
}

async function runCli(
  command: string,
  args: string[],
  cwd: string,
  logger: AgentLogger,
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
      logger.emit(
        "error",
        `invocation failed before start (backend=${command}): ${err.message}`,
      );
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

function parseClaudeRun(run: CliRunResult, logger: AgentLogger): AgentResult {
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
    const staleMatch = /No conversation found with session ID:\s*([0-9a-f-]{36})/i.exec(
      run.stderr || run.stdout,
    );
    if (staleMatch) {
      logger.emit("warn", `stale session detected: ${staleMatch[0]}`);
      throw new StaleSessionError(staleMatch[1]!, "claude");
    }
    const detail = toSingleLine((run.stderr || run.stdout).slice(0, 200));
    logger.emit(
      "error",
      `invocation did not return structured JSON (backend=claude, no session started): ${detail}`,
    );
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
    logger.emit(
      "error",
      "response missing session_id (backend=claude, no agent was started)",
    );
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

  if (parsed.is_error) {
    logger.emit(
      "warn",
      `session ${parsed.session_id} returned error output (backend=claude)`,
    );
  } else if (looksStuckOrUnhelpful(output)) {
    logger.emit(
      "warn",
      `session ${parsed.session_id} produced low-signal output (backend=claude, possible stuck/unhelpful run)`,
    );
  }
  logger.emit(
    "debug",
    `parsed response (backend=claude): session=${parsed.session_id} is_error=${parsed.is_error} turns=${parsed.num_turns ?? "?"} duration_ms=${parsed.duration_ms ?? "?"} cost_usd=${parsed.cost_usd ?? "?"} output_preview=${toSingleLine(
      output.slice(0, 300),
    )}`,
  );

  return {
    sessionId: parsed.session_id,
    output,
    isError: parsed.is_error,
    costUsd: parsed.cost_usd,
  };
}

function parseCodexRun(run: CliRunResult, logger: AgentLogger): AgentResult {
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
    logger.emit(
      "error",
      "response missing thread_id (backend=codex, no agent was started)",
    );
    throw new Error(
      `codex response missing thread_id: ${run.stdout.slice(0, 500)}\nstderr: ${run.stderr.slice(0, 500)}`,
    );
  }

  if (isError || looksStuckOrUnhelpful(output)) {
    logger.emit(
      "warn",
      `session ${sessionId} returned ${isError ? "error" : "low-signal"} output (backend=codex)`,
    );
  }
  logger.emit(
    "debug",
    `parsed response (backend=codex): session=${sessionId} is_error=${isError} output_preview=${toSingleLine(
      output.slice(0, 300),
    )}`,
  );

  return { sessionId, output, isError, costUsd };
}

function makeAgentLogger(loop?: AgentLoop): AgentLogger {
  const currentLevel = resolveLogLevel();
  const scope = loop ? `[${loop}] [agent]` : "[agent]";
  return {
    currentLevel,
    emit: (level, message) => {
      const line = `[${level}] ${scope} ${message}`;
      writeToLog(line);
      if (level === "error") {
        console.error(line);
        return;
      }
      if (level === "warn") {
        console.warn(line);
        return;
      }
      if (LOG_LEVEL_RANK[level] <= LOG_LEVEL_RANK[currentLevel]) {
        console.log(line);
      }
    },
  };
}

function resolveLogLevel(): LogLevel {
  const raw = (
    process.env.SUPERFIELD_LOG_LEVEL ??
    process.env.LOG_LEVEL ??
    "info"
  )
    .trim()
    .toLowerCase();
  if (
    raw === "error" ||
    raw === "warn" ||
    raw === "info" ||
    raw === "debug" ||
    raw === "trace"
  ) {
    return raw;
  }
  console.warn(
    `[warn] [agent] Ignoring invalid SUPERFIELD_LOG_LEVEL=${JSON.stringify(
      process.env.SUPERFIELD_LOG_LEVEL ?? process.env.LOG_LEVEL,
    )}; using "info"`,
  );
  return "info";
}

function logInvocationStart(
  backend: AgentBackend,
  opts: AgentOpts,
  logger: AgentLogger,
): void {
  const resume = opts.sessionId ? `resume(${opts.sessionId})` : "new-session";
  const task = opts.task ?? extractTaskType(opts.prompt);
  const issueNumber = extractIssueNumber(opts.prompt);
  const issuePart = issueNumber === null ? "" : ` issue=#${issueNumber}`;
  logger.emit(
    "info",
    `invoke ${resume} backend=${backend} task=${task}${issuePart}`,
  );
  logger.emit(
    "debug",
    `model=${opts.model ?? "default"} max_turns=${opts.maxTurns ?? 50} cwd=${opts.worktreePath}`,
  );
  logger.emit(
    "trace",
    `prompt:\n${prettyPromptPreview(opts.prompt)}`,
  );
}

function logRawCliResult(
  backend: AgentBackend,
  run: CliRunResult,
  logger: AgentLogger,
): void {
  logger.emit(
    "trace",
    `cli response (backend=${backend}): exit_code=${run.code} stdout=${toSingleLine(
      run.stdout.slice(0, 500),
    )} stderr=${toSingleLine(run.stderr.slice(0, 500))}`,
  );
}

function prettyPromptPreview(prompt: string): string {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .slice(0, 8);
  const joined = lines.join("\n");
  const clipped = joined.length > 700 ? `${joined.slice(0, 700)}\n...` : joined;
  return clipped
    .split("\n")
    .map((line) => `  | ${line}`)
    .join("\n");
}

function looksStuckOrUnhelpful(output: string): boolean {
  const text = output.trim().toLowerCase();
  if (!text) return true;
  return /max turns|cannot proceed|unable to continue|stuck|insufficient context|no changes made/.test(
    text,
  );
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractTaskType(prompt: string): string {
  const match = /^\s*##\s*Task:\s*(.+)\s*$/m.exec(prompt);
  if (!match) return "unknown";
  return match[1]!.trim().toLowerCase();
}

function extractIssueNumber(prompt: string): number | null {
  const headingMatch = /^\s*###\s+Issue\s+#(\d+)\b/m.exec(prompt);
  if (headingMatch) return Number(headingMatch[1]);

  const bodyMatch = /\bissue\s+#(\d+)\b/i.exec(prompt);
  if (bodyMatch) return Number(bodyMatch[1]);

  return null;
}

function readTextField(obj: Record<string, unknown>): string {
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.error === "string") return obj.error;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.result === "string") return obj.result;
  return "";
}

function isRetryableRateLimit(value: string): boolean {
  return /rate limit|rate-limit|429|too many requests|quota exceeded|temporarily unavailable|throttl|hit your limit|usage limit|resets?\s+\d/i.test(
    value,
  );
}

function isRetryableRateLimitError(err: unknown): boolean {
  if (err instanceof AgentRateLimitError) return true;
  if (err instanceof Error) return isRetryableRateLimit(err.message);
  return false;
}

function isUnsupportedModelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /model.+not supported|invalid_request_error/i.test(err.message);
}

function truncateForError(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}
