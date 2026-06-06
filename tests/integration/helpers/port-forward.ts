/**
 * @file tests/integration/helpers/port-forward.ts
 *
 * kubectl port-forward wrapper for Layer 3 integration tests.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Shared helpers" section.
 *
 * Starts a `kubectl port-forward` process targeting a Service or Pod in a
 * given namespace and returns a handle with the resolved host/port and a
 * `close()` method that terminates the child process cleanly.
 *
 * ## Usage
 *
 * ```ts
 * const fwd = await portForward('calypso-test-ns', 'svc/api', 0, 3000);
 * // fwd.host === '127.0.0.1', fwd.port === <random ephemeral port>
 * await fetch(`http://${fwd.host}:${fwd.port}/health`);
 * fwd.close();
 * ```
 *
 * ## Integration points
 *
 * - `kubectl` must be on PATH and have credentials for the target cluster.
 * - The target Service/Pod must exist and be Ready before `portForward` is
 *   called; otherwise kubectl exits early and the returned promise rejects.
 * - `wait-ready.ts` should be used first to ensure pods are Available.
 *
 * ## Risks
 *
 * - kubectl port-forward has a 30-minute idle timeout by default; tests
 *   should call `close()` promptly after use to avoid resource leaks.
 * - If `localPort` 0 is specified, a free port is selected by the OS and
 *   parsed from kubectl's stdout.
 */

import { spawn } from 'node:child_process';

export interface PortForwardHandle {
  /** The loopback host the forward is bound to. Always '127.0.0.1'. */
  host: string;
  /** The local port the forward is bound to. */
  port: number;
  /** Terminate the kubectl port-forward process. */
  close(): void;
}

/**
 * Start a `kubectl port-forward` and wait until it is ready to accept
 * connections.
 *
 * @param namespace   Kubernetes namespace.
 * @param target      Resource to forward, e.g. `svc/api` or `pod/api-abc123`.
 * @param localPort   Local port to bind; use 0 to let the OS pick a free port.
 * @param remotePort  Port exposed by the target resource.
 * @param timeoutMs   Milliseconds to wait for kubectl to report the forward is
 *                    ready before rejecting. Defaults to 15 000.
 */
export function portForward(
  namespace: string,
  target: string,
  localPort: number,
  remotePort: number,
  timeoutMs = 15_000,
): Promise<PortForwardHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'kubectl',
      [
        'port-forward',
        '-n', namespace,
        target,
        `${localPort}:${remotePort}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let resolvedPort = localPort;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`portForward(${namespace}/${target}) timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // kubectl prints: "Forwarding from 127.0.0.1:NNNN -> MMMM"
      const match = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(text);
      if (match && !settled) {
        resolvedPort = parseInt(match[1], 10);
        settled = true;
        clearTimeout(timer);
        resolve({
          host: '127.0.0.1',
          port: resolvedPort,
          close() {
            child.kill('SIGTERM');
          },
        });
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`kubectl port-forward exited early with code ${code}`));
      }
    });
  });
}
