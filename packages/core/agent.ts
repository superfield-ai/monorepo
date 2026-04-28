import { spawn } from "node:child_process";
import { makeLogger, type Logger } from "./logger.ts";
import {
  resolveJobCandidates,
  type JobType,
  type CandidateEntry,
} from "./job-registry.ts";
import { availabilityStore } from "./backend-availability.ts";
import { AgentError } from "./errors.ts";
export {
  type AgentBackend,
  type AgentMode,
  type AgentLoop,
  ModelTier,
  type ModelMapping,
  type BackendModelMapping,
  MODEL_TIER_MAPPING,
  getModelForBackend,
  translateModelForBackend,
  isValidModelTier,
  modelTierFromString,
} from "./models.ts";
import {
  type AgentBackend,
  type AgentMode,
  type AgentLoop,
  getModelForBackend,
  translateModelForBackend,
} from "./models.ts";

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

type AgentLogger = Logger;

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
  /**
   * Inference job type — drives backend + model selection via the job registry.
   * Defaults to `"dev"` when omitted (claude/sonnet preferred, codex/opencode fallback).
   */
  jobType?: JobType;
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

class AgentRateLimitError extends AgentError {
  constructor(
    readonly backend: AgentBackend,
    message: string,
  ) {
    super(message, { context: { backend } });
  }
}

export class StaleSessionError extends AgentError {
  constructor(
    readonly sessionId: string,
    readonly backend: AgentBackend,
  ) {
    super(`Session ${sessionId} not found on ${backend} — session is stale`, {
      context: { sessionId, backend },
    });
  }
}

/**
 * Spawns the configured agent CLI in headless mode and returns the session ID and output.
 *
 * Backend and model are selected via the job registry (see `docs/runtime-agent-selection.md`).
 * Pass `jobType` to use the appropriate preferred + fallover list for the inference role;
 * omit it to fall back to the default `"dev"` profile (claude → codex → opencode).
 *
 * The caller is responsible for persisting `result.sessionId` so that the next
 * invocation for the same slot can resume where this one left off.
 */
export async function spawnAgent(opts: AgentOpts): Promise<AgentResult> {
  const logger = makeAgentLogger(opts.loop);

  // Honour explicit provider override (opts or env var), else use job registry.
  const envProvider =
    process.env.SUPERFIELD_AGENT_PROVIDER?.trim().toLowerCase();
  const explicitProvider =
    opts.provider && opts.provider !== "auto"
      ? opts.provider
      : envProvider && envProvider !== "auto"
        ? (envProvider as AgentBackend)
        : undefined;

  let candidates: CandidateEntry[];
  if (explicitProvider) {
    candidates = [
      {
        backend: explicitProvider,
        model: opts.model ?? getModelForBackend(explicitProvider),
      },
    ];
  } else {
    candidates = resolveJobCandidates(opts.jobType ?? "dev");
  }

  const available = candidates.filter((c) =>
    availabilityStore.isAvailable(c.backend),
  );

  if (available.length === 0) {
    logger.emit(
      "warn",
      "all backends rate limited or unavailable, waiting for availability...",
    );
    return await waitForAvailableBackend(opts, candidates, logger);
  }

  return await callWithCandidatePriority(opts, available, logger);
}

async function callWithCandidatePriority(
  opts: AgentOpts,
  candidates: CandidateEntry[],
  logger: AgentLogger,
): Promise<AgentResult> {
  for (const candidate of candidates) {
    const result = await tryCandidate(candidate, opts, logger);
    if (result !== null) {
      return result;
    }
  }
  return await waitForAvailableBackend(opts, candidates, logger);
}

/**
 * Attempt one candidate. Returns null when the backend should be skipped
 * (rate-limit, model rejection) so the caller moves to the next candidate.
 * Throws on non-retriable errors.
 *
 * Model-rejection retry: when the caller supplied `opts.model` and the backend
 * rejected the translated model name, we retry the same backend with no model
 * override (let the CLI use its default). This covers the pattern where the
 * user pins e.g. "haiku" and the fallback backend doesn't support that alias.
 */
async function tryCandidate(
  candidate: CandidateEntry,
  opts: AgentOpts,
  logger: AgentLogger,
): Promise<AgentResult | null> {
  const { backend } = candidate;

  if (opts.sessionId) {
    const sessionBackend = inferBackendFromSessionId(opts.sessionId);
    if (sessionBackend && sessionBackend !== backend) {
      logger.emit(
        "info",
        `session ${opts.sessionId} belongs to ${sessionBackend}, skipping ${backend}`,
      );
      return null;
    }
  }

  // Caller model override takes precedence; translate it for this backend.
  // Fall back to the registry model when no override is set.
  const model = opts.model
    ? translateModelForBackend(opts.model, backend, "claude")
    : candidate.model;

  logger.emit("info", `trying backend=${backend}`);

  try {
    const result = await spawnAgentBackend(backend, { ...opts, model }, logger);
    availabilityStore.clearAvailable(backend);
    return result;
  } catch (err) {
    if (isRetryableRateLimitError(err)) {
      const backendName =
        err instanceof AgentRateLimitError ? err.backend : backend;
      logger.emit("warn", `${backendName} was rate limited`);
      availabilityStore.markUnavailable(backend);
      return null;
    }

    if (isUnsupportedModelError(err)) {
      logger.emit("warn", `${backend} rejected model, falling back`);

      // If a caller model was translated and rejected, retry without model override.
      if (opts.model !== undefined) {
        logger.emit("info", `retrying ${backend} without model override`);
        try {
          const retryResult = await spawnAgentBackend(
            backend,
            { ...opts, model: undefined },
            logger,
          );
          availabilityStore.clearAvailable(backend);
          return retryResult;
        } catch (retryErr) {
          if (isRetryableRateLimitError(retryErr)) {
            availabilityStore.markUnavailable(backend);
          }
          // Fall through to null — move to next candidate.
        }
      }
      return null;
    }

    throw err;
  }
}

function inferBackendFromSessionId(sessionId: string): AgentBackend | null {
  if (sessionId.startsWith("claude-")) {
    return "claude";
  }
  if (sessionId.startsWith("codex-")) {
    return "codex";
  }
  if (sessionId.startsWith("ses_")) {
    return "opencode";
  }
  return null;
}

async function waitForAvailableBackend(
  opts: AgentOpts,
  candidates: CandidateEntry[],
  logger: AgentLogger,
): Promise<AgentResult> {
  const pollIntervalMs = 60_000;
  logger.emit(
    "warn",
    `all backends rate limited; polling every ${pollIntervalMs / 1000}s for availability`,
  );

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    logger.emit("info", "polling backends availability...");
    const available = candidates.filter((c) =>
      availabilityStore.isAvailable(c.backend),
    );

    if (available.length > 0) {
      logger.emit(
        "info",
        `backends now available: ${available.map((c) => c.backend).join(", ")}`,
      );
      return await callWithCandidatePriority(opts, available, logger);
    }
  }
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
    const args = buildArgs(backend, opts, logger);
    logger.emit(
      "trace",
      `running command: ${backend} ${args.join(" ")} in ${opts.worktreePath}`,
    );
    run = await runCli(backend, args, opts.worktreePath, logger);
  } finally {
    clearInterval(heartbeat);
  }
  logRawCliResult(backend, run, logger);

  if (backend === "claude") {
    return parseClaudeRun(run, logger);
  }

  if (backend === "opencode") {
    return parseOpencodeRun(run, logger);
  }

  return parseCodexRun(run, logger);
}

function buildArgs(
  backend: AgentBackend,
  opts: AgentOpts,
  _logger: AgentLogger,
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

  if (backend === "opencode") {
    const args: string[] = [
      "run",
      "--format",
      "json",
      "--dir",
      opts.worktreePath,
    ];

    const model = opts.model ?? getModelForBackend(backend);
    args.push("--model", model);

    if (opts.sessionId) {
      args.push("--continue", "--session", opts.sessionId);
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
  logger: AgentLogger,
): Promise<CliRunResult> {
  return new Promise<CliRunResult>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Claude Code authenticates via OAuth stored in CLAUDE_CONFIG_DIR.
        // The `claude` binary is often invoked via a shell alias that sets
        // this var, but aliases don't propagate to child processes — so we
        // set it explicitly here. Fall back to ~/.claude if not already set.
        CLAUDE_CONFIG_DIR:
          process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`,
      },
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
    const staleMatch =
      /No conversation found with session ID:\s*([0-9a-f-]{36})/i.exec(
        run.stderr || run.stdout,
      );
    if (staleMatch?.[1]) {
      logger.emit("warn", `stale session detected: ${staleMatch[0]}`);
      throw new StaleSessionError(staleMatch[1], "claude");
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

function parseOpencodeRun(run: CliRunResult, logger: AgentLogger): AgentResult {
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
      continue;
    }

    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;

    if (record.type === "step_finish" && typeof record.part === "object") {
      const part = record.part as Record<string, unknown>;
      if (part.tokens && typeof part.tokens === "object") {
        const tokens = part.tokens as Record<string, number>;
        const cost = tokens.cost;
        if (typeof cost === "number") {
          costUsd = cost;
        }
      }
    }

    if (
      record.sessionID &&
      typeof record.sessionID === "string" &&
      !sessionId
    ) {
      sessionId = record.sessionID;
    }

    if (record.type === "text" && typeof record.part === "object") {
      const part = record.part as Record<string, unknown>;
      if (typeof part.text === "string") {
        output = part.text;
      }
    }

    if (record.type === "error") {
      isError = true;
      if (record.message) {
        output = String(record.message);
      }
    }
  }

  if (!sessionId) {
    if (isRetryableRateLimit(run.stdout) || isRetryableRateLimit(run.stderr)) {
      throw new AgentRateLimitError(
        "opencode",
        `opencode was rate limited: ${truncateForError(run.stderr || run.stdout)}`,
      );
    }
    logger.emit(
      "error",
      "response missing sessionID (backend=opencode, no session started)",
    );
    throw new Error(
      `opencode response missing sessionID: ${run.stdout.slice(0, 500)}`,
    );
  }

  logger.emit(
    "debug",
    `parsed response (backend=opencode): session=${sessionId} is_error=${isError} output_preview=${toSingleLine(
      output.slice(0, 300),
    )}`,
  );

  return { sessionId, output, isError, costUsd };
}

function makeAgentLogger(loop?: AgentLoop): AgentLogger {
  const scope = loop ? `[${loop}] [agent]` : "[agent]";
  return makeLogger(scope);
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
  logger.emit("trace", `prompt:\n${prettyPromptPreview(opts.prompt)}`);
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
  if (!match?.[1]) return "unknown";
  return match[1].trim().toLowerCase();
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
