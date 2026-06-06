import { resolve } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

/**
 * @file control.ts
 *
 * `superfield control` — start the studio HTTP server.
 *
 * Usage:
 *   superfield control [--port <n>] [--path <path>] [--api-url <url>]
 *
 *   --port      Studio server port. Default: 7000.
 *   --path      Superfield project root (SUPERFIELD_REPO_ROOT). Default: cwd.
 *   --api-url   Superfield API base URL. Default: http://127.0.0.1:7837.
 *
 * Builds the browser UI then delegates to the `sf-serve` Rust binary for all
 * serving. No Node/Bun backend process is started. The Rust binary owns the
 * HTTP server, WebSocket, static asset serving, and API endpoints.
 *
 * See: docs/architecture.md — §Control Webapp and §7 Current Gaps (#7).
 */

const CONTROL_WEB_APP_DIR = resolve(import.meta.dirname, "../../control/apps");
const CONTROL_WEB_DIST_DIR = resolve(
  import.meta.dirname,
  "../../control/apps/dist",
);

/**
 * Resolved path to the `sf-serve` Rust binary that replaces the Bun control
 * server. Set via SF_SERVE_BIN env var, or defaults to `sf-serve` on PATH.
 *
 * Issue #377 ships this binary; issue #378 wires the CLI to it.
 */
function resolveSfServeBin(): string {
  return process.env.SF_SERVE_BIN ?? "sf-serve";
}

export interface ControlCommandDeps {
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  exit?: (code: number) => never;
  /** Injected browser bundle builder (tests). */
  _buildControlWeb?: () => Promise<void>;
  /**
   * Injected Rust backend starter (tests — avoids spawning a real binary).
   *
   * Production default: spawns `sf-serve` with env vars set by controlCommand.
   * The promise resolves when the process exits (i.e. never under normal
   * operation — the process stays alive until SIGINT/SIGTERM).
   */
  _startSfServe?: (opts: SfServeOpts) => Promise<void>;
}

export interface SfServeOpts {
  /** Port sf-serve should bind on (maps to CONTROL_PORT env var). */
  port: number;
  /** Absolute path to the built browser UI static assets. */
  assetsDir: string;
  /** Superfield project root (SUPERFIELD_REPO_ROOT). */
  projectRoot?: string;
  /** Superfield dev-loop API URL (SUPERFIELD_API_URL). */
  apiUrl: string;
}

export function parseControlArgs(args: string[]): {
  port?: number;
  path?: string;
  apiUrl?: string;
  help: boolean;
  unknown: string[];
} {
  let port: number | undefined;
  let path: string | undefined;
  let apiUrl: string | undefined;
  let help = false;
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--port") {
      const val = args[++i];
      const parsed = parseInt(val ?? "", 10);
      if (Number.isNaN(parsed)) unknown.push(arg);
      else port = parsed;
    } else if (arg.startsWith("--port=")) {
      const parsed = parseInt(arg.slice("--port=".length), 10);
      if (Number.isNaN(parsed)) unknown.push(arg);
      else port = parsed;
    } else if (arg === "--path") {
      path = args[++i];
    } else if (arg.startsWith("--path=")) {
      path = arg.slice("--path=".length);
    } else if (arg === "--api-url") {
      apiUrl = args[++i];
    } else if (arg.startsWith("--api-url=")) {
      apiUrl = arg.slice("--api-url=".length);
    } else {
      unknown.push(arg);
    }
  }

  return { port, path, apiUrl, help, unknown };
}

export function controlUsage(): string {
  return `
superfield control [--port <n>] [--path <path>] [--api-url <url>]

  Start the studio HTTP server (served by the Rust sf-serve backend).

  --port      Studio server port. Default: 7000.
  --path      Superfield project root (SUPERFIELD_REPO_ROOT). Default: cwd.
  --api-url   Superfield API base URL. Default: http://127.0.0.1:7837.

  The browser UI is built locally (Vite), then served by the sf-serve Rust
  binary. No Node/Bun backend process is started. Set SF_SERVE_BIN to
  override the binary path.
`.trim();
}

export async function controlCommand(
  args: string[],
  deps: ControlCommandDeps = {},
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);

  const _buildControlWeb =
    deps._buildControlWeb ??
    (async () => {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const proc = nodeSpawn("bun", ["run", "build"], {
          cwd: CONTROL_WEB_APP_DIR,
          stdio: "inherit",
        });
        proc.on("error", reject);
        proc.on("close", resolve);
      });
      if (exitCode !== 0) {
        throw new Error(
          `Browser UI build failed in ${CONTROL_WEB_APP_DIR} (exit ${exitCode})`,
        );
      }
    });

  const _startSfServe =
    deps._startSfServe ??
    (async (opts: SfServeOpts) => {
      const sfServeBin = resolveSfServeBin();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const proc = nodeSpawn(sfServeBin, [], {
          env: {
            ...process.env,
            CONTROL_PORT: String(opts.port),
            CONTROL_ASSETS_DIR: opts.assetsDir,
            SUPERFIELD_API_URL: opts.apiUrl,
            ...(opts.projectRoot
              ? {
                  SUPERFIELD_REPO_ROOT: opts.projectRoot,
                  CONTROL_SOURCE_DIR: opts.projectRoot,
                }
              : {}),
          },
          stdio: "inherit",
        });
        proc.on("error", reject);
        proc.on("close", resolve);
      });
      if (exitCode !== 0) {
        throw new Error(`sf-serve exited with code ${exitCode}`);
      }
    });

  const parsed = parseControlArgs(args);

  if (parsed.help) {
    log(controlUsage());
    return;
  }

  if (parsed.unknown.length > 0) {
    warn(`Unknown arguments: ${parsed.unknown.join(" ")}`);
    log(controlUsage());
    exit(1);
    return;
  }

  await _buildControlWeb();

  const port = parsed.port ?? parseInt(process.env.CONTROL_PORT ?? "7000", 10);
  const projectRoot = parsed.path ?? process.env.SUPERFIELD_REPO_ROOT;
  const apiUrl =
    parsed.apiUrl ?? process.env.SUPERFIELD_API_URL ?? "http://127.0.0.1:7837";
  const assetsDir = process.env.CONTROL_ASSETS_DIR ?? CONTROL_WEB_DIST_DIR;

  // Propagate to environment so any child process or library reads consistent
  // values. sf-serve also inherits these via the env passed to nodeSpawn above.
  if (parsed.port !== undefined) {
    process.env.CONTROL_PORT = String(parsed.port);
  }
  if (parsed.path !== undefined) {
    process.env.SUPERFIELD_REPO_ROOT = parsed.path;
    process.env.CONTROL_SOURCE_DIR = parsed.path;
  }
  if (parsed.apiUrl !== undefined) {
    process.env.SUPERFIELD_API_URL = parsed.apiUrl;
  }

  await _startSfServe({ port, assetsDir, projectRoot, apiUrl });
}
