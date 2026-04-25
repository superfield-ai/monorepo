/**
 * @file index.ts
 *
 * Studio Server — main entrypoint.
 *
 * Canonical spec: docs/studio-mode.md — "Architecture — Studio Server" and
 * "Stopping Studio Mode" sections.
 *
 * Responsibilities implemented here:
 *
 *   • Bind a Bun HTTP server on 0.0.0.0:STUDIO_PORT (default 7000).
 *   • Delegate all incoming requests to the router (router.ts).
 *   • Register a SIGINT handler that:
 *       1. Stops accepting new connections.
 *       2. Sends SIGTERM to all child processes via ProcessManager.
 *       3. Waits up to 5 s, then SIGKILL.
 *       4. Exits cleanly.
 *
 * The server binds on all interfaces (0.0.0.0) because Studio Mode is used
 * on networked development hosts. Cluster services bind to localhost only —
 * the studio server is the sole network-reachable ingress point for cluster
 * traffic.
 *
 * Integration points for downstream issues:
 *   - Claude CLI subprocess: will be registered with pm.register() after
 *     being spawned by the claude-session module (separate issue).
 *   - kubectl --watch subprocess: will be registered with pm.register()
 *     after being spawned by the cluster-watch module (separate issue).
 *   - SSE endpoint: will be added to the router (separate issue).
 */

import { loadConfig, vlog } from './config';
import { ProcessManager } from './process-manager';
import { route } from './router';

const config = loadConfig();
const pm = new ProcessManager();

vlog(config, 'Configuration loaded:', JSON.stringify({
  port: config.port,
  logDir: config.logDir,
  clusterContext: config.clusterContext,
  webServiceUrl: config.webServiceUrl,
  apiServiceUrl: config.apiServiceUrl,
  assetsDir: config.assetsDir ?? '(unset)',
  verbose: config.verbose,
}, null, 2));

// ── HTTP server ─────────────────────────────────────────────────────────────

let shuttingDown = false;

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: config.port,

  async fetch(req: Request): Promise<Response> {
    if (shuttingDown) {
      return new Response('Service Unavailable — studio server is shutting down', { status: 503 });
    }
    const url = new URL(req.url);
    vlog(config, `→ ${req.method} ${url.pathname}${url.search}`);
    const res = await route(req, config);
    vlog(config, `← ${res.status} ${url.pathname}`);
    return res;
  },

  error(err: Error): Response {
    console.error('[studio] Unhandled server error:', err.message);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

console.log(`\n⬡ Studio Mode`);
console.log(`  Studio:  http://0.0.0.0:${config.port}`);
console.log(`  App:     http://0.0.0.0:${config.port}/app/`);
console.log(`  API:     http://0.0.0.0:${config.port}/api/`);
console.log(`  Cluster: context=${config.clusterContext}`);
console.log(`  Logs:    ${config.logDir}`);
console.log(`\nPress Ctrl+C to stop.\n`);

// ── Graceful shutdown ───────────────────────────────────────────────────────
//
// Spec: docs/studio-mode.md — "Stopping Studio Mode"
//
//   1. Stop accepting new browser connections and SSE subscriptions.
//   2. Send SIGTERM to all child processes (Claude CLI, kubectl subprocesses).
//   3. Wait up to 5 seconds for child processes to exit.
//   4. SIGKILL any that have not exited.
//   5. Close the listening socket and exit.

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[studio] Received ${signal}. Shutting down…`);

  // Stop the Bun HTTP server (closes the listening socket, in-flight requests
  // continue until they resolve naturally — Bun does not have a built-in drain
  // API so we rely on the short timeout window for in-flight SSE connections).
  server.stop();

  // Terminate all tracked child processes (SIGTERM → 5 s → SIGKILL).
  await pm.shutdown();

  console.log('[studio] Goodbye.');
  process.exit(0);
}

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch((err) => {
    console.error('[studio] Error during shutdown:', err);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch((err) => {
    console.error('[studio] Error during shutdown:', err);
    process.exit(1);
  });
});

// Export for integration tests and downstream modules.
export { server, pm, config };
