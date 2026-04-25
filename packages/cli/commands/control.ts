/**
 * @file control.ts
 *
 * `superfield control` — start the studio HTTP server.
 *
 * Usage:
 *   superfield control [--port <n>] [--repo <path>] [--api-url <url>]
 *
 *   --port      Studio server port. Default: 7000.
 *   --repo      Repo root (CALYPSO_REPO_ROOT). Default: cwd.
 *   --api-url   Superfield API base URL. Default: http://127.0.0.1:7837.
 *
 * Starts the studio HTTP server from @superfield/studio. Does not start
 * any dev loops. Does not read ~/.superfield/config.yaml. The only external
 * dependency is the superfield API server at --api-url (used for agent turns
 * and steering). If the API is unreachable at startup a warning is logged and
 * the server starts anyway.
 */

export interface ControlCommandDeps {
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  exit?: (code: number) => never;
}

export function parseControlArgs(args: string[]): {
  port?: number;
  repo?: string;
  apiUrl?: string;
  help: boolean;
  unknown: string[];
} {
  let port: number | undefined;
  let repo: string | undefined;
  let apiUrl: string | undefined;
  let help = false;
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--port') {
      const val = args[++i];
      const parsed = parseInt(val ?? '', 10);
      if (Number.isNaN(parsed)) unknown.push(arg);
      else port = parsed;
    } else if (arg.startsWith('--port=')) {
      const parsed = parseInt(arg.slice('--port='.length), 10);
      if (Number.isNaN(parsed)) unknown.push(arg);
      else port = parsed;
    } else if (arg === '--repo') {
      repo = args[++i];
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
    } else if (arg === '--api-url') {
      apiUrl = args[++i];
    } else if (arg.startsWith('--api-url=')) {
      apiUrl = arg.slice('--api-url='.length);
    } else {
      unknown.push(arg);
    }
  }

  return { port, repo, apiUrl, help, unknown };
}

export function controlUsage(): string {
  return `
superfield control [--port <n>] [--repo <path>] [--api-url <url>]

  Start the studio HTTP server.

  --port      Studio server port. Default: 7000.
  --repo      Repo root (CALYPSO_REPO_ROOT). Default: cwd.
  --api-url   Superfield dev-loop API base URL. Default: http://127.0.0.1:7837.

  The dev-loop API is used for agent turns and steering. If it is unreachable
  at startup, a warning is logged and the server starts anyway. Start a dev
  loop separately with 'superfield start <repo>' or via the orchestrator view.
`.trim();
}

export async function controlCommand(
  args: string[],
  deps: ControlCommandDeps = {},
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);

  const parsed = parseControlArgs(args);

  if (parsed.help) {
    log(controlUsage());
    return;
  }

  if (parsed.unknown.length > 0) {
    warn(`Unknown arguments: ${parsed.unknown.join(' ')}`);
    log(controlUsage());
    exit(1);
  }

  // Apply CLI overrides to env vars before importing @superfield/studio so
  // that loadConfig() picks them up.
  if (parsed.port !== undefined) {
    process.env.STUDIO_PORT = String(parsed.port);
  }
  if (parsed.repo !== undefined) {
    process.env.CALYPSO_REPO_ROOT = parsed.repo;
  }
  if (parsed.apiUrl !== undefined) {
    process.env.SUPERFIELD_API_URL = parsed.apiUrl;
  }

  const apiUrl = parsed.apiUrl ?? process.env.SUPERFIELD_API_URL ?? 'http://127.0.0.1:7837';

  // Health-check the dev-loop API. Warn if unreachable but proceed regardless.
  try {
    const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) {
      warn(`[studio] Warning: dev-loop API at ${apiUrl}/health returned HTTP ${res.status}. Agent turns may fail.`);
    }
  } catch {
    warn(`[studio] Warning: dev-loop API unreachable at ${apiUrl}. Agent turns will fail until a dev loop is running.`);
  }

  const { startStudio } = await import('@superfield/studio');
  await startStudio();
}
