/**
 * Playwright global setup — starts the superfield API fixture and the studio
 * server before any test runs.
 *
 * Both servers run in-process (same Node/Bun process). The studio server is
 * spawned as a child process (needs Bun.serve which only works in Bun). The
 * superfield API server uses node:http and runs in-process here.
 *
 * Requires the web app to already be built:
 *   bun run --cwd packages/studio/apps build
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { join, delimiter, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const E2E_ROOT = resolve(import.meta.dirname);
const REPO_ROOT = resolve(E2E_ROOT, '../../../../');
const FIXTURES_DIR = resolve(E2E_ROOT, '../fixtures');
const WEB_DIST = resolve(E2E_ROOT, '../../apps/dist');
const STUDIO_PORT = parseInt(process.env.STUDIO_E2E_PORT ?? '7009', 10);

async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export default async function globalSetup() {
  // Start the superfield API server in-process on a random port.
  const { ApiState } = await import('@superfield/core/api-state');
  const { startApiServer } = await import('@superfield/core/api-server');

  const state = new ApiState();
  const noopLogger = { currentLevel: 'info' as const, emit: () => {} };
  const apiServer = startApiServer({ port: 0, state, logger: noopLogger });
  await new Promise<void>((r) => apiServer.once('listening', r));
  const apiPort = (apiServer.address() as AddressInfo).port;

  // Inject the claude stub into PATH so agent turns return canned responses.
  const origPath = process.env.PATH ?? '';
  process.env.PATH = `${FIXTURES_DIR}${delimiter}${origPath}`;
  process.env.CLAUDE_E2E_LOG_PATH = '/tmp/claude-studio-e2e.log';

  const apiUrl = `http://127.0.0.1:${apiPort}`;

  // Spawn the studio server as a Bun child process.
  // Use full path to bun since Playwright runs in Node.js which may have a
  // different PATH than the shell.
  const bunBin = process.env.BUN_INSTALL
    ? join(process.env.BUN_INSTALL, 'bin', 'bun')
    : join(process.env.HOME ?? '/root', '.bun', 'bin', 'bun');

  const studioProc: ChildProcess = spawn(
    bunBin,
    [
      resolve(REPO_ROOT, 'packages/cli/bin/superfield.ts'),
      'control',
      '--port', String(STUDIO_PORT),
      '--api-url', apiUrl,
    ],
    {
      env: {
        ...process.env,
        STUDIO_PORT: String(STUDIO_PORT),
        SUPERFIELD_API_URL: apiUrl,
        STUDIO_ASSETS_DIR: WEB_DIST,
        // Suppress verbose startup logs in CI output.
        STUDIO_VERBOSE: '0',
      },
      stdio: 'pipe',
      cwd: REPO_ROOT,
    },
  );

  studioProc.stderr?.on('data', (d: Buffer) => {
    // Forward studio server stderr so test failures are diagnosable.
    process.stderr.write(`[studio] ${d}`);
  });

  await waitFor(`http://127.0.0.1:${STUDIO_PORT}/health`).catch(() => {
    // /health may not exist on the studio server; fall back to root.
    return waitFor(`http://127.0.0.1:${STUDIO_PORT}/`);
  });

  // Stash handles for globalTeardown.
  (globalThis as Record<string, unknown>).__studioProc = studioProc;
  (globalThis as Record<string, unknown>).__apiServer = apiServer;
  (globalThis as Record<string, unknown>).__origPath = origPath;
}
