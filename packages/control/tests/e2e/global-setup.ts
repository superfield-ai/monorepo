/**
 * Playwright global setup — builds the browser UI and spawns the sf-serve
 * Rust backend before any test runs.
 *
 * The serving backend is the Rust `sf-serve` binary (issue #377). No
 * Node/Bun API server is started — all routing is handled by sf-serve.
 *
 * Requires:
 *   1. The web app already built: bun run --cwd packages/control/apps build
 *   2. The sf-serve binary available at SF_SERVE_BIN or on PATH.
 *
 * See: docs/architecture.md — §Control Webapp, §7 gap #7.
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

  // Resolve the sf-serve binary. SF_SERVE_BIN overrides the PATH lookup so
  // CI can point at the binary built from the Rust workspace.
  const sfServeBin = process.env.SF_SERVE_BIN ?? "sf-serve";

  // Spawn the sf-serve Rust backend. It builds no Node/Bun processes — the
  // CLI binary handles HTTP serving, WebSocket, static assets, and API routes.
  const studioProc: ChildProcess = spawn(sfServeBin, [], {
    env: {
      ...process.env,
      CONTROL_PORT: String(CONTROL_PORT),
      CONTROL_ASSETS_DIR: WEB_DIST,
      SUPERFIELD_REPO_ROOT: REPO_ROOT,
      CONTROL_SOURCE_DIR: REPO_ROOT,
      // Suppress verbose startup logs in CI output.
      CONTROL_VERBOSE: "0",
    },
    stdio: "pipe",
    cwd: REPO_ROOT,
  });

  // Capture all output to a file so crashes are diagnosable from CI artifacts.
  const studioLogPath = resolve(testRoot, "studio-e2e.log");
  const studioLogStream = createWriteStream(studioLogPath, { flags: "w" });
  const writeLog = (prefix: string, d: Buffer): void => {
    const line = `${prefix} ${d}`;
    studioLogStream.write(line);
    process.stderr.write(line);
  };
  studioProc.stdout?.on("data", (d: Buffer) => writeLog("[sf-serve out]", d));
  studioProc.stderr?.on("data", (d: Buffer) => writeLog("[sf-serve err]", d));
  studioProc.on("exit", (code, signal) => {
    studioLogStream.write(
      `[sf-serve exit] code=${String(code)} signal=${String(signal)}\n`,
    );
    studioLogStream.end();
  });

  await waitFor(`http://127.0.0.1:${CONTROL_PORT}/health`).catch(() => {
    return waitFor(`http://127.0.0.1:${CONTROL_PORT}/`);
  });

  // Stash handles for globalTeardown.
  (globalThis as Record<string, unknown>).__studioProc = studioProc;
  // __apiServer is intentionally absent — no Node API server is started.
  (globalThis as Record<string, unknown>).__origPath = origPath;
  (globalThis as Record<string, unknown>).__studioLogPath = studioLogPath;
}
