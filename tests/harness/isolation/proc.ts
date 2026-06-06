/**
 * Subprocess helper that always runs with the pinned environment built by
 * isolation/env.ts. Never inherits the developer's environment beyond
 * PATH (which buildPinnedEnv sets explicitly).
 */
import { spawn } from 'node:child_process';
import { buildPinnedEnv } from './env';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  /** Extra env entries layered on top of the pinned base. */
  env?: Record<string, string>;
  /** Wall-clock timeout in milliseconds; default 60_000. */
  timeoutMs?: number;
  /** Optional stdin payload. */
  stdin?: string;
}

export async function run(
  command: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  const env = buildPinnedEnv(opts.env);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = performance.now();

  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL the immediate process. Descendants may keep stdio pipes
      // open (e.g. `sh -c 'sleep N'`) so we listen on 'exit' rather than
      // 'close' to avoid hanging on orphaned descendants' fds.
      child.kill('SIGKILL');
    }, timeoutMs);

    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: performance.now() - start,
      });
    };

    child.on('error', (err) => {
      stderr += `\n[harness] spawn error: ${err.message}`;
      settle(-1);
    });

    child.on('exit', (code, signal) => {
      settle(code ?? (signal ? 128 + 9 : -1));
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
