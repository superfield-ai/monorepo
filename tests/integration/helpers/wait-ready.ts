/**
 * @file tests/integration/helpers/wait-ready.ts
 *
 * Poll kubectl until all Deployments in a namespace reach the Available
 * condition, or throw a descriptive error on timeout.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Shared helpers" section.
 *
 * ## Usage
 *
 * ```ts
 * await waitReady('calypso-test-ns');             // default 120 s timeout
 * await waitReady('calypso-test-ns', 60_000);     // custom 60 s timeout
 * ```
 *
 * The function polls `kubectl get deployments -n <namespace>` every
 * `pollIntervalMs` milliseconds. Each Deployment is considered Available when
 * the ready replica count equals the desired replica count.
 *
 * ## Integration points
 *
 * - Must be called after `applyManifests` and before any test that calls
 *   `portForward`.
 * - Depends on `kubectl` being on PATH and the namespace already existing.
 *
 * ## Risks
 *
 * - Image pull errors cause indefinite pending state. The timeout surfaces this
 *   with a clear error message listing which Deployments are still not ready.
 * - Deployments with 0 desired replicas (scaled-down) are treated as ready so
 *   that scaled-down test fixtures do not block the poll.
 */

import { spawnSync } from 'node:child_process';

interface DeploymentStatus {
  name: string;
  ready: number;
  desired: number;
}

/** Parse `kubectl get deployments -n <ns> -o wide` output into status rows. */
function parseDeployments(raw: string): DeploymentStatus[] {
  const lines = raw.trim().split('\n');
  // First line is the header row — skip it.
  if (lines.length < 2) return [];
  return lines.slice(1).map((line) => {
    const cols = line.trim().split(/\s+/);
    // NAME  READY  UP-TO-DATE  AVAILABLE  AGE
    const name = cols[0];
    // READY column is "N/M"
    const readyParts = (cols[1] ?? '0/0').split('/');
    const ready = parseInt(readyParts[0], 10);
    const desired = parseInt(readyParts[1] ?? '0', 10);
    return { name, ready, desired };
  });
}

/**
 * Wait until all Deployments in `namespace` are Available (ready >= desired).
 *
 * @param namespace      Kubernetes namespace to watch.
 * @param timeoutMs      Maximum wait time in milliseconds. Defaults to 120 000.
 * @param pollIntervalMs Polling interval in milliseconds. Defaults to 3 000.
 * @throws if the timeout expires before all Deployments are ready.
 */
export async function waitReady(
  namespace: string,
  timeoutMs = 120_000,
  pollIntervalMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = spawnSync(
      'kubectl',
      ['get', 'deployments', '-n', namespace],
      { encoding: 'utf8', timeout: 10_000 },
    );

    if (result.status === 0 && result.stdout) {
      const deployments = parseDeployments(result.stdout);

      if (deployments.length > 0) {
        const notReady = deployments.filter(
          (d) => d.desired > 0 && d.ready < d.desired,
        );

        if (notReady.length === 0) {
          return; // All deployments ready.
        }
      }
    }

    await new Promise<void>((res) => setTimeout(res, pollIntervalMs));
  }

  // Timed out — collect final state for a helpful error.
  const finalResult = spawnSync(
    'kubectl',
    ['get', 'deployments', '-n', namespace],
    { encoding: 'utf8', timeout: 10_000 },
  );
  const deployments = parseDeployments(finalResult.stdout ?? '');
  const notReady = deployments
    .filter((d) => d.desired > 0 && d.ready < d.desired)
    .map((d) => `${d.name} (${d.ready}/${d.desired} ready)`)
    .join(', ');

  throw new Error(
    `waitReady(${namespace}): timed out after ${timeoutMs}ms. ` +
      `Not ready: ${notReady || '(could not list deployments)'}`,
  );
}
