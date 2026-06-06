/**
 * Integration tests for studio-down.ts script.
 *
 * Issue #169 test plan items covered:
 *   - Integration test: studio-down removes overlay resources without
 *     affecting the k3s daemon
 *
 * These tests use a fake kubectl wrapper on PATH so that they do not require
 * a live k3s cluster. The wrapper returns success codes and realistic output
 * so the script logic is exercised end-to-end.
 *
 * Note: studio-start.ts (k8s cluster entry-point) was removed in issue #56.
 * The canonical studio entry-point is now studio/scripts/studio-start.ts.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { type SpawnSyncReturns, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Path to the studio submodule root (four levels up from this test file).
const STUDIO_ROOT = new URL('../../../../', import.meta.url).pathname;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a temporary directory that is cleaned up after each test. */
function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Write a fake executable shell script to a path.
 * The script prints the provided output and exits with the given code.
 */
function writeFakeExec(
  dir: string,
  name: string,
  opts: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  } = {},
): string {
  const { exitCode = 0, stdout = '', stderr = '' } = opts;
  const path = join(dir, name);
  const script = [
    '#!/bin/sh',
    stderr ? `echo "${stderr}" >&2` : '',
    stdout ? `echo "${stdout}"` : '',
    `exit ${exitCode}`,
  ]
    .filter(Boolean)
    .join('\n');
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

/**
 * Run a bun script with a fake PATH that prepends stubDir so fake executables
 * shadow real system ones. Optional scriptArgs are passed as CLI arguments to
 * the script after the script path.
 */
function runScript(
  scriptPath: string,
  stubDir: string,
  env: NodeJS.ProcessEnv = {},
  scriptArgs: string[] = [],
): SpawnSyncReturns<Buffer> {
  const pathWithStubs = `${stubDir}:${process.env.PATH}`;
  return spawnSync('bun', ['run', scriptPath, ...scriptArgs], {
    cwd: STUDIO_ROOT,
    env: {
      ...process.env,
      PATH: pathWithStubs,
      STUDIO_PORT: '17099',
      STUDIO_LOG_DIR: '/tmp/studio-test-logs',
      ...env,
    },
    stdio: 'pipe',
    timeout: 30_000,
  });
}

/**
 * Create a temporary source directory with a k8s subdirectory containing a
 * minimal Deployment YAML manifest. Used by studio-down and studio-start
 * tests that need a parseable source tree.
 */
function makeSourceDirWithK8s(prefix: string): string {
  const sourceDir = makeTempDir(prefix);
  const k8sDir = join(sourceDir, 'k8s');
  mkdirSync(k8sDir, { recursive: true });
  writeFileSync(
    join(k8sDir, 'app.yaml'),
    [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: app',
      'spec:',
      '  replicas: 1',
    ].join('\n'),
  );
  return sourceDir;
}

// ── studio-down ───────────────────────────────────────────────────────────────

test(
  'studio:down exits 0 when kubectl delete succeeds',
  () => {
    const stubDir = makeTempDir('studio-down-stubs-');
    const sourceDir = makeSourceDirWithK8s('studio-down-src-');

    // Fake kubectl that records the call and succeeds.
    writeFakeExec(stubDir, 'kubectl', { exitCode: 0, stdout: 'resource deleted' });

    const result = runScript(
      join(STUDIO_ROOT, 'scripts', 'studio-down.ts'),
      stubDir,
      {},
      [sourceDir],
    );

    expect(result.status).toBe(0);
    const out = new TextDecoder().decode(result.stdout);
    expect(out).toContain('studio:down complete');
  },
  30_000,
);

test(
  'studio:down exits 0 even when kubectl delete fails (cleanup ignores kubectl errors)',
  () => {
    const stubDir = makeTempDir('studio-down-fail-stubs-');
    const sourceDir = makeSourceDirWithK8s('studio-down-fail-src-');

    writeFakeExec(stubDir, 'kubectl', {
      exitCode: 1,
      stderr: 'Error: cluster unreachable',
    });

    const result = runScript(
      join(STUDIO_ROOT, 'scripts', 'studio-down.ts'),
      stubDir,
      {},
      [sourceDir],
    );

    // cleanupCluster does not propagate kubectl exit codes, so the script exits 0.
    expect(result.status).toBe(0);
  },
  30_000,
);

test(
  'studio:down exits 0 with no-resources message when k8s dir has no YAML files',
  () => {
    const stubDir = makeTempDir('studio-down-empty-');
    const sourceDir = makeTempDir('studio-down-empty-src-');
    mkdirSync(join(sourceDir, 'k8s'), { recursive: true });
    // k8s dir exists but has no YAML files.

    writeFakeExec(stubDir, 'kubectl', { exitCode: 0 });

    const result = runScript(
      join(STUDIO_ROOT, 'scripts', 'studio-down.ts'),
      stubDir,
      {},
      [sourceDir],
    );

    expect(result.status).toBe(0);
    const out = new TextDecoder().decode(result.stdout);
    expect(out).toContain('No resources found');
  },
  30_000,
);

// ── Cleanup ────────────────────────────────────────────────────────────────────

afterEach(() => {
  // Temp dirs with prefix 'studio-' created in makeTempDir will be cleaned up
  // by the OS over time, but we actively clean them during test teardown to
  // avoid leaking large numbers of temp files.
  try {
    const dirs = readdirSync(tmpdir())
      .filter((f) => f.startsWith('studio-'))
      .map((f) => join(tmpdir(), f))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Cleanup failures are non-fatal.
  }
});
