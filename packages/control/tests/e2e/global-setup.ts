/**
 * Playwright global setup — starts the Rust sf-serve backend before any test
 * runs.
 *
 * The server is started by running `superfield serve --bind 127.0.0.1:<port>`
 * with CONTROL_ASSETS_DIR pointed at the pre-built browser UI dist directory.
 * sf-serve is resolved from the SF_SERVE_BIN environment variable, or falls
 * back to `superfield` on PATH (the combined binary that includes `sf-serve`
 * via the `serve` subcommand).
 *
 * Requires the web app to already be built:
 *   bun run --cwd packages/control/apps build
 *
 * Requires a reachable Postgres database via DATABASE_URL (or the default
 * postgres://superfield:superfield@localhost:5432/superfield used by CI).
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

async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
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

/** Resolve the sf-serve / superfield binary path. */
function resolveServeBin(): string {
  // SF_SERVE_BIN may point directly at the compiled superfield binary built
  // by `cargo build -p superfield`.  The `serve` subcommand starts sf-serve.
  return process.env.SF_SERVE_BIN ?? "superfield";
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

  // Inject the claude stub into PATH so agent turns return canned responses.
  const origPath = process.env.PATH ?? "";
  process.env.PATH = `${FIXTURES_DIR}${delimiter}${origPath}`;

  // Start the Rust sf-serve backend (via `superfield serve`).
  // CONTROL_ASSETS_DIR points at the pre-built browser UI so the SPA loads.
  // DATABASE_URL must be set in the environment; the CI workflow provisions a
  // Postgres service and exports this variable automatically.
  const serveBin = resolveServeBin();

  const serveProc: ChildProcess = spawn(
    serveBin,
    ["serve", `--bind`, `127.0.0.1:${CONTROL_PORT}`],
    {
      env: {
        ...process.env,
        CONTROL_ASSETS_DIR: WEB_DIST,
        // Default DATABASE_URL for local development; CI overrides this.
        DATABASE_URL:
          process.env.DATABASE_URL ??
          "postgres://superfield:superfield@localhost:5432/superfield",
      },
      stdio: "pipe",
      cwd: REPO_ROOT,
    },
  );

  // Capture all server output to a file so crashes are diagnosable from CI
  // artifacts. The file path is stashed in globalThis so global-teardown can
  // surface it on failure.
  const serverLogPath = resolve(testRoot, "sf-serve-e2e.log");
  const serverLogStream = createWriteStream(serverLogPath, { flags: "w" });
  const writeLog = (prefix: string, d: Buffer): void => {
    const line = `${prefix} ${d}`;
    serverLogStream.write(line);
    process.stderr.write(line);
  };
  serveProc.stdout?.on("data", (d: Buffer) => writeLog("[serve out]", d));
  serveProc.stderr?.on("data", (d: Buffer) => writeLog("[serve err]", d));
  serveProc.on("exit", (code, signal) => {
    serverLogStream.write(
      `[serve exit] code=${String(code)} signal=${String(signal)}\n`,
    );
    serverLogStream.end();
  });

  // Wait for the /health endpoint — sf-serve exposes this as a public liveness
  // probe (no auth required).
  await waitFor(`http://127.0.0.1:${CONTROL_PORT}/health`).catch(() => {
    return waitFor(`http://127.0.0.1:${CONTROL_PORT}/`);
  });

  // Stash handles for globalTeardown.
  (globalThis as Record<string, unknown>).__studioProc = serveProc;
  (globalThis as Record<string, unknown>).__origPath = origPath;
  (globalThis as Record<string, unknown>).__studioLogPath = serverLogPath;
}
