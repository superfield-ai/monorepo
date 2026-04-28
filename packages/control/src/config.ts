/**
 * @file config.ts
 *
 * Environment variable configuration for the Studio Server.
 *
 * Canonical spec: docs/studio-mode.md — "Environment Variables" section.
 *
 * The studio server reads all tunable values from environment variables at
 * startup. This module centralises the defaults so they are never duplicated
 * across the codebase.
 *
 * | Variable                 | Default          | Purpose                                |
 * | ------------------------ | ---------------- | -------------------------------------- |
 * | CONTROL_PORT              | 7000             | Port the studio server listens on      |
 * | CONTROL_LOG_DIR           | ../studio-logs   | Directory for Claude response logs     |
 * | CONTROL_CLUSTER_CONTEXT   | default          | kubectl context for the studio cluster |
 * | CONTROL_OPEN_BROWSER      | (unset)          | Set to 1 to auto-open the browser      |
 * | CONTROL_WEB_SERVICE_HOST  | 127.0.0.1        | ClusterIP host for the web service     |
 * | CONTROL_WEB_SERVICE_PORT  | (from k8s YAML)  | ClusterIP port for the web service     |
 * | CONTROL_WEB_SERVICE_NAME  | web              | Service name to discover in k8s YAML   |
 * | CONTROL_API_SERVICE_HOST  | 127.0.0.1        | ClusterIP host for the api service     |
 * | CONTROL_API_SERVICE_PORT  | 31415            | ClusterIP port for the api service     |
 * | CONTROL_ASSETS_DIR        | (unset)          | Optional pre-built browser UI for debug|
 * | CONTROL_VERBOSE           | (unset)          | Set to 1 for verbose startup logging   |
 * | SUPERFIELD_API_URL       | http://127.0.0.1:7837 | Dev loop API base URL             |
 */

import { join } from "path";
import { discoverServicePort } from "../../control-core/manifest-parser";

export interface ControlConfig {
  /** Port the studio server binds on (0.0.0.0:CONTROL_PORT). */
  port: number;
  /** Directory for Claude response JSONL logs. */
  logDir: string;
  /** kubectl context used for proxy target resolution. */
  clusterContext: string;
  /** Whether to open the browser automatically after start. */
  openBrowser: boolean;
  /** Upstream URL for the /app/* reverse-proxy (web ClusterIP service). */
  webServiceUrl: string;
  /** Upstream URL for the /api/* reverse-proxy (api ClusterIP service). */
  apiServiceUrl: string;
  /** Absolute path to the compiled browser UI static assets. */
  assetsDir: string | undefined;
  /** Embedded asset map for compiled-binary mode (Bun `with { type: "file" }` imports). */
  embeddedAssets?: ReadonlyMap<string, string>;
  /** When true, emit detailed diagnostic logs during startup and routing. */
  verbose?: boolean;
  /** Base URL of the superfield dev-loop API server (for agent turns and steering). */
  superfieldApiUrl?: string;
}

export function loadConfig(): ControlConfig {
  const port = parseInt(process.env.CONTROL_PORT ?? "7000", 10);
  const logDir = process.env.CONTROL_LOG_DIR ?? "../studio-logs";
  const clusterContext = process.env.CONTROL_CLUSTER_CONTEXT ?? "default";
  const openBrowser = process.env.CONTROL_OPEN_BROWSER === "1";

  const webHost = process.env.CONTROL_WEB_SERVICE_HOST ?? "127.0.0.1";

  // Derive the web service port from the app's k8s manifests when possible.
  // When SUPERFIELD_REPO_ROOT is set, read the "web" Service port directly from
  // the app's k8s YAML rather than relying on a hardcoded env var default.
  // CONTROL_WEB_SERVICE_PORT always wins if explicitly set.
  let webPort: number;
  if (process.env.CONTROL_WEB_SERVICE_PORT) {
    webPort = parseInt(process.env.CONTROL_WEB_SERVICE_PORT, 10);
  } else {
    const appRoot = process.env.SUPERFIELD_REPO_ROOT;
    const webServiceName = process.env.CONTROL_WEB_SERVICE_NAME ?? "web";
    let discovered: number | null = null;
    if (appRoot) {
      try {
        discovered = discoverServicePort(join(appRoot, "k8s"), webServiceName);
      } catch {
        // Discovery is best-effort — fall through to default.
      }
    }
    webPort = discovered ?? 80;
  }

  const webServiceUrl = `http://${webHost}:${webPort}`;

  const apiHost = process.env.CONTROL_API_SERVICE_HOST ?? "127.0.0.1";
  const apiPort = parseInt(process.env.CONTROL_API_SERVICE_PORT ?? "31415", 10);
  const apiServiceUrl = `http://${apiHost}:${apiPort}`;

  const assetsDir = process.env.CONTROL_ASSETS_DIR;
  const verbose = process.env.CONTROL_VERBOSE === "1";
  const superfieldApiUrl =
    process.env.SUPERFIELD_API_URL ?? "http://127.0.0.1:7837";

  return {
    port,
    logDir,
    clusterContext,
    openBrowser,
    webServiceUrl,
    apiServiceUrl,
    assetsDir,
    verbose,
    superfieldApiUrl,
  };
}

/**
 * Verbose logger — prints timestamped diagnostic messages when verbose mode
 * is enabled. No-ops silently otherwise.
 */
export function vlog(
  config: Pick<ControlConfig, "verbose">,
  ...args: unknown[]
): void {
  if (!config.verbose) return;
  const ts = new Date().toISOString();
  console.log(`[studio:verbose ${ts}]`, ...args);
}
