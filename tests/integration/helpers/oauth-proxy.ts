/**
 * @file tests/integration/helpers/oauth-proxy.ts
 *
 * In-process HTTP intercept proxy for outbound OAuth traffic in Layer 3
 * integration tests.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "OAuth interception" section.
 *
 * ## Purpose
 *
 * The Calypso studio server reads `OAUTH_BASE_URL` from the environment and
 * directs all OAuth HTTP calls to that URL. By setting `OAUTH_BASE_URL` to
 * the proxy's base URL the test can:
 *
 *   1. Return deterministic fixture payloads without hitting a real OAuth
 *      provider.
 *   2. Capture every outbound request for assertion.
 *
 * ## Usage
 *
 * ```ts
 * const oauthProxy = await startOAuthProxy({
 *   '/oauth/init':     { url: 'https://fixture.example/oauth?state=abc' },
 *   '/oauth/complete': { access_token: 'fixture-token-123' },
 * });
 * process.env.OAUTH_BASE_URL = oauthProxy.baseUrl;
 * // … run test …
 * oauthProxy.requests // array of captured CapturedRequest objects
 * await oauthProxy.close();
 * ```
 *
 * ## Integration points
 *
 * - The studio server must read `OAUTH_BASE_URL` from the environment and use
 *   it as the base for all outbound OAuth HTTP calls.
 * - Tests must set `process.env.OAUTH_BASE_URL` before the server is started.
 *
 * ## Risks
 *
 * - Routes not listed in `routes` return 404. Tests must register all paths
 *   the server under test will call.
 * - Request bodies are buffered in memory; very large OAuth payloads could
 *   cause OOM in a memory-constrained CI environment.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A request captured by the proxy for later assertion. */
export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** A running OAuth intercept proxy. */
export interface OAuthProxy {
  /** HTTP base URL of the proxy, e.g. `http://127.0.0.1:54321`. */
  baseUrl: string;
  /** All requests captured by the proxy in arrival order. */
  requests: CapturedRequest[];
  /** Stop the proxy server. */
  close(): Promise<void>;
}

/**
 * Start an in-process HTTP proxy that intercepts OAuth calls.
 *
 * @param routes  Map from URL path to fixture response body (serialised as
 *                JSON). Unknown paths return 404.
 * @param port    Local port to bind. Defaults to 0 (OS picks a free port).
 */
export function startOAuthProxy(
  routes: Record<string, unknown>,
  port = 0,
): Promise<OAuthProxy> {
  const captured: CapturedRequest[] = [];

  return new Promise((resolve, reject) => {
    const server: Server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const path = req.url ?? '/';
        let rawBody = '';

        req.on('data', (chunk: Buffer) => {
          rawBody += chunk.toString();
        });

        req.on('end', () => {
          let parsedBody: unknown = rawBody;
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            // Body is not JSON; keep as raw string.
          }

          captured.push({
            method: req.method ?? 'GET',
            path,
            headers: req.headers as Record<string, string | string[] | undefined>,
            body: parsedBody,
          });

          const fixture = routes[path];
          if (fixture === undefined) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `no fixture for ${path}` }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fixture));
        });

        req.on('error', () => {
          res.writeHead(500);
          res.end();
        });
      },
    );

    server.on('error', reject);

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        requests: captured,
        close(): Promise<void> {
          return new Promise((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          );
        },
      });
    });
  });
}
