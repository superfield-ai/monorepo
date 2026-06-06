/**
 * Validator runner.
 *
 * A scenario's validator (TypeScript script) runs in the merged tree's
 * working directory and exits 0 iff the merge is correct. Wall-clock
 * timeout is 60s per docs/test-plan.md §5.
 *
 * Unlike the lane runners, validators inherit the developer's full env
 * — they need access to language toolchains (tsc, cargo, rustup) that
 * live under HOME/RUSTUP_HOME/CARGO_HOME. Git-determinism pinning only
 * applies to the lane subprocesses (init/commit/merge), not to the
 * downstream behavioral checks.
 */
import { spawn } from 'node:child_process';

export interface ValidatorResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runValidator(
  validatorPath: string,
  treeDir: string,
  timeoutMs = 60_000,
): Promise<ValidatorResult> {
  return new Promise((resolveRun) => {
    const child = spawn('bun', ['--bun', validatorPath], {
      cwd: treeDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        ok: !timedOut && code === 0,
        exitCode: code,
        stdout,
        stderr,
        timedOut,
      });
    };
    child.on('error', (e) => {
      stderr += `\n[validator] spawn error: ${e.message}`;
      settle(-1);
    });
    child.on('exit', (code, signal) => {
      settle(code ?? (signal ? 128 + 9 : -1));
    });
  });
}
