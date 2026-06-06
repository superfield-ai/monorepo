/**
 * @file tests/integration/helpers/cluster.ts
 *
 * Namespace lifecycle and manifest-apply helpers for Layer 3 integration tests.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Shared helpers" section.
 *
 * Each integration test suite acquires a dedicated k3s namespace via
 * `createNamespace`, applies the k8s manifests into it via `applyManifests`,
 * and tears the namespace down in `afterAll` via `deleteNamespace`.
 *
 * The helpers are thin wrappers around `kubectl` so the tests stay readable
 * without coupling them to any particular Node.js k8s client library.
 *
 * ## Integration points
 *
 * - `kubectl` must be on PATH and configured for the target cluster before the
 *   test process starts.
 * - `k8s/base/` must exist at repo root and contain valid Kubernetes YAML
 *   manifests (studio.yaml, web.yaml, rbac.yaml).
 * - `wait-ready.ts` in the same directory polls until deployments are Available
 *   after `applyManifests` completes.
 *
 * ## Risks discovered during scout pass
 *
 * - Tests should be skipped automatically when no cluster is available (see
 *   `clusterAvailable()` helper).
 * - Namespace deletion is best-effort — errors are logged but do not throw so
 *   that `afterAll` teardown proceeds even when the cluster is degraded.
 */

import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

/** Returns true when a local k3s cluster appears to be reachable. */
export function clusterAvailable(): boolean {
  const result = spawnSync('kubectl', ['cluster-info', '--request-timeout=3s'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return result.status === 0;
}

/**
 * Create a Kubernetes namespace.
 *
 * @param name  Namespace name. Should be unique per test suite run.
 * @throws if `kubectl create namespace` exits non-zero.
 */
export function createNamespace(name: string): void {
  execSync(`kubectl create namespace ${name}`, { stdio: 'pipe' });
}

/**
 * Delete a Kubernetes namespace and all resources in it.
 *
 * Errors are swallowed so that `afterAll` teardown always completes.
 *
 * @param name  Namespace name to delete.
 */
export function deleteNamespace(name: string): void {
  try {
    execSync(`kubectl delete namespace ${name} --ignore-not-found`, { stdio: 'pipe' });
  } catch (err) {
    // Best-effort teardown — do not throw from afterAll.
    console.error(`[cluster] deleteNamespace(${name}) failed:`, (err as Error).message);
  }
}

/**
 * Apply k8s manifests from a directory into the given namespace.
 *
 * Runs `kubectl apply -f <manifestDir> -n <namespace>` — no kustomize needed.
 * The manifest directory must contain plain Kubernetes YAML files
 * (studio.yaml, web.yaml, rbac.yaml).
 *
 * @param namespace    Target namespace (must already exist).
 * @param manifestDir  Path to the directory containing k8s YAML manifests.
 *                     Defaults to `k8s/base` relative to repo root.
 */
export function applyManifests(
  namespace: string,
  manifestDir = 'k8s/base',
): void {
  execSync(`kubectl apply -f ${manifestDir} -n ${namespace}`, { stdio: 'pipe' });
}

/**
 * Capture pod logs from the studio deployment in a namespace and write them
 * to a file under the given directory. Called during fixture teardown, before
 * the namespace is deleted, so the logs are available for CI artifact upload.
 *
 * Errors are swallowed — log capture failure must never abort teardown.
 *
 * @param namespace  The k8s namespace to capture logs from.
 * @param logDir     Directory to write `<namespace>.log` into. Defaults to
 *                   `/tmp/studio-pod-logs` (created if absent).
 */
export function capturePodLogs(
  namespace: string,
  logDir = '/tmp/studio-pod-logs',
): void {
  try {
    mkdirSync(logDir, { recursive: true });
    const result = spawnSync(
      'kubectl',
      ['logs', '-n', namespace, '-l', 'app=studio', '--tail=300', '--prefix'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const content = [
      `=== studio pod logs: ${namespace} ===`,
      result.stdout || '(no stdout)',
      result.stderr ? `--- stderr ---\n${result.stderr}` : '',
    ].join('\n');
    writeFileSync(`${logDir}/${namespace}.log`, content);
  } catch {
    // Best-effort — do not throw.
  }
}
