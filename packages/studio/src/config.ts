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
 * | STUDIO_PORT              | 7000             | Port the studio server listens on      |
 * | STUDIO_LOG_DIR           | ../studio-logs   | Directory for Claude response logs     |
 * | STUDIO_CLUSTER_CONTEXT   | default          | kubectl context for the studio cluster |
 * | STUDIO_OPEN_BROWSER      | (unset)          | Set to 1 to auto-open the browser      |
 * | STUDIO_WEB_SERVICE_HOST  | 127.0.0.1        | ClusterIP host for the web service     |
 * | STUDIO_WEB_SERVICE_PORT  | (from k8s YAML)  | ClusterIP port for the web service     |
 * | STUDIO_API_SERVICE_HOST  | 127.0.0.1        | ClusterIP host for the api service     |
 * | STUDIO_API_SERVICE_PORT  | 31415            | ClusterIP port for the api service     |
 * | STUDIO_ASSETS_DIR        | (unset)          | Directory of pre-built browser UI      |
 * | STUDIO_VERBOSE           | (unset)          | Set to 1 for verbose startup logging   |
 */

import { join } from 'path';
import { discoverServicePort } from '../../studio-core/manifest-parser';

export interface StudioConfig {
  /** Port the studio server binds on (0.0.0.0:STUDIO_PORT). */
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
  /** When true, emit detailed diagnostic logs during startup and routing. */
  verbose: boolean;
}

export function loadConfig(): StudioConfig {
  const port = parseInt(process.env.STUDIO_PORT ?? '7000', 10);
  const logDir = process.env.STUDIO_LOG_DIR ?? '../studio-logs';
  const clusterContext = process.env.STUDIO_CLUSTER_CONTEXT ?? 'default';
  const openBrowser = process.env.STUDIO_OPEN_BROWSER === '1';

  const webHost = process.env.STUDIO_WEB_SERVICE_HOST ?? '127.0.0.1';

  // Derive the web service port from the app's k8s manifests when possible.
  // When CALYPSO_REPO_ROOT is set, read the "web" Service port directly from
  // the app's k8s YAML rather than relying on a hardcoded env var default.
  // STUDIO_WEB_SERVICE_PORT always wins if explicitly set.
  let webPort: number;
  if (process.env.STUDIO_WEB_SERVICE_PORT) {
    webPort = parseInt(process.env.STUDIO_WEB_SERVICE_PORT, 10);
  } else {
    const appRoot = process.env.CALYPSO_REPO_ROOT;
    let discovered: number | null = null;
    if (appRoot) {
      try {
        discovered = discoverServicePort(join(appRoot, 'k8s'), 'web');
      } catch {
        // Discovery is best-effort — fall through to default.
      }
    }
    webPort = discovered ?? 80;
  }

  const webServiceUrl = `http://${webHost}:${webPort}`;

  const apiHost = process.env.STUDIO_API_SERVICE_HOST ?? '127.0.0.1';
  const apiPort = parseInt(process.env.STUDIO_API_SERVICE_PORT ?? '31415', 10);
  const apiServiceUrl = `http://${apiHost}:${apiPort}`;

  const assetsDir = process.env.STUDIO_ASSETS_DIR;
  const verbose = process.env.STUDIO_VERBOSE === '1';

  return {
    port,
    logDir,
    clusterContext,
    openBrowser,
    webServiceUrl,
    apiServiceUrl,
    assetsDir,
    verbose,
  };
}

/**
 * Verbose logger — prints timestamped diagnostic messages when verbose mode
 * is enabled. No-ops silently otherwise.
 */
export function vlog(config: Pick<StudioConfig, 'verbose'>, ...args: unknown[]): void {
  if (!config.verbose) return;
  const ts = new Date().toISOString();
  console.log(`[studio:verbose ${ts}]`, ...args);
}
