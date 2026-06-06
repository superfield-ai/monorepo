/**
 * Hooks system — the decoupled-toolchain layer per whitepaper §6.3 and
 * engineering-plan §7a.
 *
 * Discovers executable files under `.sharp/hooks/<event>/`, runs them
 * with a JSON context on stdin and the merged-tree path as `cwd` (for
 * pre-merge), and treats a non-zero exit as a veto for events that
 * support veto.
 *
 * Events:
 *   pre-commit   pre-merge   pre-push   post-commit   post-merge
 *
 * Stock examples ship under `examples/hooks/` (tsc-noemit.ts,
 * cargo-check.ts) but the merge engine itself is decoupled from any
 * specific toolchain — it only invokes whatever the user has dropped
 * into `.sharp/hooks/`.
 */
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export type HookEvent = 'pre-commit' | 'post-commit' | 'pre-merge' | 'post-merge' | 'pre-push';

export interface HookResult {
  hookPath: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface HookExecOptions {
  /** Working directory the hook runs in (cwd). For pre-merge, this is the candidate tree. */
  cwd: string;
  /** JSON-serializable context written to the hook's stdin. */
  context?: unknown;
  /** Wall-clock timeout per hook. */
  timeoutMs?: number;
}

export async function discoverHooks(workspaceRoot: string, event: HookEvent): Promise<string[]> {
  const dir = resolve(workspaceRoot, '.sharp', 'hooks', event);
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    const path = resolve(dir, e.name);
    try {
      const s = await stat(path);
      // Honor the executable bit on POSIX; on Windows we'd accept .ts/.js
      // and call them via bun. Sharp's target hosts are Linux/macOS.
      if (s.mode & 0o111) out.push(path);
    } catch {
      // ignore
    }
  }
  out.sort();
  return out;
}

export async function runHook(hookPath: string, opts: HookExecOptions): Promise<HookResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = performance.now();
  return new Promise((resolveRun) => {
    const child = spawn(hookPath, [], {
      cwd: opts.cwd,
      env: { ...process.env, SHARP_HOOK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        hookPath,
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: performance.now() - start,
      });
    };
    child.on('error', (e) => {
      stderr += `\n[hook] spawn error: ${e.message}`;
      settle(-1);
    });
    child.on('exit', (code, signal) => {
      settle(code ?? (signal ? 128 + 9 : -1));
    });
    if (opts.context !== undefined) {
      child.stdin.write(JSON.stringify(opts.context));
    }
    child.stdin.end();
  });
}

/**
 * Run every hook for an event in lex order. Returns the first failing
 * hook (non-zero exit) for veto-events; for non-veto events the array
 * is the full set of results.
 */
export async function runHooks(
  hookPaths: readonly string[],
  opts: HookExecOptions,
): Promise<{ ok: boolean; results: HookResult[] }> {
  const results: HookResult[] = [];
  for (const path of hookPaths) {
    const r = await runHook(path, opts);
    results.push(r);
    if (r.exitCode !== 0 || r.timedOut) {
      return { ok: false, results };
    }
  }
  return { ok: true, results };
}
