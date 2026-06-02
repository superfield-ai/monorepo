/**
 * Playwright global setup — spawns the TypeScript control server (Bun) before
 * any test runs.
 *
 * The control server is started by calling `startControl()` from
 * `@superfield/control` directly, bypassing the CLI `controlCommand` which
 * delegates to the `sf-serve` Rust binary. The Rust binary is not yet
 * available as a standalone executable (gap #7 in docs/architecture.md §7 —
 * tracked in issue #377/#378). Until the binary ships, the E2E harness drives
 * the TypeScript control server that handles all routes the specs depend on,
 * including `/api/auth/register`, static-asset serving, and WebSocket.
 *
 * Requires the web app to already be built:
 *   bun run --cwd packages/control/apps build
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join, delimiter, resolve } from "node:path";
import { createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const E2E_ROOT = resolve(import.meta.dirname);
const REPO_ROOT = resolve(E2E_ROOT, "../../../../");
const FIXTURES_DIR = resolve(E2E_ROOT, "../fixtures");
const WEB_DIST = resolve(E2E_ROOT, "../../apps/dist");
const CONTROL_PORT = parseInt(process.env.CONTROL_E2E_PORT ?? "7009", 10);

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
  const testRoot = mkdtempSync(join(tmpdir(), "superfield-e2e-"));
  mkdirSync(join(testRoot, "home"), { recursive: true });
  mkdirSync(join(testRoot, "control-logs"), { recursive: true });
  mkdirSync(join(testRoot, "superfield-logs"), { recursive: true });
  process.env.SUPERFIELD_TEST_ROOT = testRoot;
  const realHome = process.env.HOME;
  // Pin the Playwright browser cache to the real home so it survives the HOME
  // override below (Playwright defaults to $HOME/.cache/ms-playwright).
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && realHome) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(
      realHome,
      ".cache",
      "ms-playwright",
    );
  }
  process.env.HOME = join(testRoot, "home");
  process.env.USERPROFILE = join(testRoot, "home");
  process.env.CONTROL_LOG_DIR = join(testRoot, "control-logs");
  process.env.SUPERFIELD_LOG_DIR = join(testRoot, "superfield-logs");
  process.env.CLAUDE_E2E_LOG_PATH = join(testRoot, "claude-studio-e2e.log");

  // Inject the claude stub into PATH so agent turns return canned responses.
  const origPath = process.env.PATH ?? "";
  process.env.PATH = `${FIXTURES_DIR}${delimiter}${origPath}`;

  // Spawn the TypeScript control server as a Bun child process.
  // Calls startControl() directly from @superfield/control, bypassing the CLI
  // controlCommand (which delegates to the not-yet-available sf-serve binary).
  // Use full path to bun since Playwright runs in Node.js which may have a
  // different PATH than the shell.
  const bunBin = process.env.BUN_INSTALL
    ? join(process.env.BUN_INSTALL, "bin", "bun")
    : join(realHome ?? "/root", ".bun", "bin", "bun");

  const studioProc: ChildProcess = spawn(
    bunBin,
    [
      "--eval",
      `const { startControl } = await import("${resolve(REPO_ROOT, "packages/control/src/index.ts")}"); await startControl();`,
    ],
    {
      env: {
        ...process.env,
        CONTROL_PORT: String(CONTROL_PORT),
        CONTROL_ASSETS_DIR: WEB_DIST,
        // Suppress verbose startup logs in CI output.
        CONTROL_VERBOSE: "0",
      },
      stdio: "pipe",
      cwd: REPO_ROOT,
    },
  );

  // Capture all studio output to a file so crashes are diagnosable from CI
  // artifacts. The file path is stashed in globalThis so global-teardown can
  // surface it on failure.
  const studioLogPath = resolve(testRoot, "studio-e2e.log");
  const studioLogStream = createWriteStream(studioLogPath, { flags: "w" });
  const writeLog = (prefix: string, d: Buffer): void => {
    const line = `${prefix} ${d}`;
    studioLogStream.write(line);
    // Also forward to the test runner so failures are visible inline.
    process.stderr.write(line);
  };
  studioProc.stdout?.on("data", (d: Buffer) => writeLog("[studio out]", d));
  studioProc.stderr?.on("data", (d: Buffer) => writeLog("[studio err]", d));
  studioProc.on("exit", (code, signal) => {
    studioLogStream.write(
      `[studio exit] code=${String(code)} signal=${String(signal)}\n`,
    );
    studioLogStream.end();
  });

  await waitFor(`http://127.0.0.1:${CONTROL_PORT}/health`).catch(() => {
    // /health may not exist on the studio server; fall back to root.
    return waitFor(`http://127.0.0.1:${CONTROL_PORT}/`);
  });

  // Stash handles for globalTeardown.
  (globalThis as Record<string, unknown>).__studioProc = studioProc;
  (globalThis as Record<string, unknown>).__origPath = origPath;
  (globalThis as Record<string, unknown>).__studioLogPath = studioLogPath;
}
