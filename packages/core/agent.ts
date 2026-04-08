import { spawn } from "node:child_process";

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

export interface AgentOpts {
  /** Absolute path to the git worktree the agent should work in. */
  worktreePath: string;
  /** The prompt to send. */
  prompt: string;
  /** If set, resumes this Claude Code session rather than starting a new one. */
  sessionId?: string;
  /** Override the default model. */
  model?: string;
  /** Override the default max turns (default: 50). */
  maxTurns?: number;
}

export interface AgentResult {
  /** The session ID returned by Claude Code — persist this to resume later. */
  sessionId: string;
  /** Final text output from the agent. */
  output: string;
  /** True if Claude Code reported an execution error. */
  isError: boolean;
  /** Approximate cost in USD, if reported. */
  costUsd?: number;
}

/**
 * Spawns the `claude` CLI in headless mode and returns the session ID and output.
 *
 * The caller is responsible for persisting `result.sessionId` so that the next
 * invocation for the same slot can resume where this one left off.
 */
export async function spawnAgent(opts: AgentOpts): Promise<AgentResult> {
  const args = buildArgs(opts);

  return new Promise<AgentResult>((resolve, reject) => {
    const proc = spawn("claude", args, {
      cwd: opts.worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on("close", (code) => {
      const raw = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      let parsed: ClaudeJsonResult;
      try {
        parsed = JSON.parse(raw) as ClaudeJsonResult;
      } catch {
        reject(
          new Error(
            `claude exited with code ${code} and produced non-JSON output.\n` +
              `stdout: ${raw.slice(0, 500)}\n` +
              `stderr: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }

      if (!parsed.session_id) {
        reject(
          new Error(`claude response missing session_id: ${raw.slice(0, 500)}`),
        );
        return;
      }

      resolve({
        sessionId: parsed.session_id,
        output: parsed.result ?? parsed.error ?? "",
        isError: parsed.is_error,
        costUsd: parsed.cost_usd,
      });
    });
  });
}

function buildArgs(opts: AgentOpts): string[] {
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
