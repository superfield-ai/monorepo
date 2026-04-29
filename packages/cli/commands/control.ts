import { resolve } from "node:path";
import { ApiState } from "@superfield/core/api-state";
import { startApiServer } from "@superfield/core/api-server";
import type { Logger } from "@superfield/core/logger";

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
 * Starts the studio HTTP server from @superfield/control. Does not start
 * any dev loops. Does not read ~/.superfield/config.yaml. The only external
 * dependency is the superfield API server at --api-url (used for agent turns
 * and steering). If the API is unreachable at startup a warning is logged and
 * the server starts anyway.
 *
 * The browser UI bundle is rebuilt before startup so `CONTROL_ASSETS_DIR`
 * can remain optional in debug flows.
 */

const CONTROL_WEB_APP_DIR = resolve(import.meta.dirname, "../../control/apps");
const CONTROL_WEB_DIST_DIR = resolve(
  import.meta.dirname,
  "../../control/apps/dist",
);

export interface ControlCommandDeps {
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  exit?: (code: number) => never;
  /** Injected fetch for health-check (tests). */
  _fetch?: typeof fetch;
  /** Injected browser bundle builder (tests). */
  _buildControlWeb?: () => Promise<void>;
  /** Injected API server starter (tests). */
  _startApiServer?: (opts: {
    host?: string;
    port?: number;
    state: ApiState;
    logger: Logger;
  }) => ReturnType<typeof startApiServer>;
  /** Injected control starter (tests — avoids dynamic import). */
  _startControl?: () => Promise<void>;
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

  Start the studio HTTP server.

  --port      Studio server port. Default: 7000.
  --path      Superfield project root (SUPERFIELD_REPO_ROOT). Default: cwd.
  --api-url   Superfield API base URL. Default: http://127.0.0.1:7837.

  By default the command starts the local API server so the webapp can receive
  turns and steer requests immediately. If --api-url points at a non-local
  server, that remote API is used instead.
`.trim();
}

export async function controlCommand(
  args: string[],
  deps: ControlCommandDeps = {},
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);
  const _fetch = deps._fetch ?? globalThis.fetch;
  const _buildControlWeb =
    deps._buildControlWeb ??
    (async () => {
      const proc = Bun.spawn(["bun", "run", "build"], {
        cwd: CONTROL_WEB_APP_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(
          `Browser UI build failed in ${CONTROL_WEB_APP_DIR} (exit ${exitCode})`,
        );
      }
    });
  const _startControl =
    deps._startControl ??
    (async () => {
      const { startControl } = await import("@superfield/control");
      await startControl();
    });
  const _startApiServer =
    deps._startApiServer ??
    ((opts: Parameters<typeof startApiServer>[0]) => startApiServer(opts));

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

  // Apply CLI overrides to env vars before importing @superfield/control so
  // that loadConfig() picks them up.
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

  if (!process.env.CONTROL_ASSETS_DIR) {
    process.env.CONTROL_ASSETS_DIR = CONTROL_WEB_DIST_DIR;
  }

  const apiUrlOverride = parsed.apiUrl ?? process.env.SUPERFIELD_API_URL;
  const apiUrl = apiUrlOverride ?? "http://127.0.0.1:7837";

  if (apiUrlOverride === undefined) {
    _startApiServer({
      host: "127.0.0.1",
      port: 7837,
      state: new ApiState(),
      logger: {
        currentLevel: "info",
        emit: (level, message) => {
          if (level === "warn") warn(`[studio] ${message}`);
          else console.log(`[studio] ${message}`);
        },
      },
    });
  } else {
    // Remote API or unparsable URL: keep the existing startup probe so we still
    // warn operators if the target is unavailable.
    try {
      const res = await _fetch(`${apiUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        warn(
          `[studio] Warning: API at ${apiUrl}/health returned HTTP ${res.status}. Agent turns may fail.`,
        );
      }
    } catch {
      warn(
        `[studio] Warning: API unreachable at ${apiUrl}. Agent turns may fail until it is running.`,
      );
    }
  }

  await _startControl();
}
