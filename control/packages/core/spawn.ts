/**
 * @file spawn.ts
 *
 * Thin wrapper around child_process.spawnSync for testability.
 *
 * Exported as a standalone module so tests can vi.mock() it and
 * all callers pick up the mock through their import binding.
 *
 * Supports optional stdin piping via opts.input — this is used by
 * applyManifests() to pipe concatenated YAML into kubectl apply.
 *
 * Supports optional streaming via opts.stream — this is used by
 * long-running commands like `docker build` and `kubectl apply`
 * where live output visibility matters. When stream is true,
 * stdio is set to 'inherit' so the child process writes directly
 * to the parent's terminal; stdout and stderr in the result will
 * be empty strings.
 *
 * @see docs/cluster-definition.md — "Startup sequence" step 8
 */

import { spawnSync } from 'child_process';

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  cwd?: string;
  /** Raw string to pipe into the child process's stdin. */
  input?: string;
  /**
   * When true, the child process inherits the parent's stdio so its
   * output is visible in the terminal in real time. stdout and stderr
   * in the returned SpawnResult will be empty strings.
   *
   * Use this for long-running commands where user visibility matters
   * (e.g. docker build, kubectl apply). Mutually exclusive with input.
   */
  stream?: boolean;
}

export function spawn(
  cmd: string,
  args: string[],
  opts?: SpawnOptions,
): SpawnResult {
  if (opts?.stream) {
    const result = spawnSync(cmd, args, {
      cwd: opts.cwd,
      stdio: 'inherit',
    });
    return {
      status: result.status,
      stdout: '',
      stderr: '',
    };
  }

  const result = spawnSync(cmd, args, {
    ...opts,
    input: opts?.input,
    stdio: opts?.input ? ['pipe', 'pipe', 'pipe'] : 'pipe',
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}
