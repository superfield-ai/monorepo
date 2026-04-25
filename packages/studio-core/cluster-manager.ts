/**
 * @file cluster-manager.ts
 *
 * Manages the lifecycle of a studio k3s cluster.
 *
 * Responsibilities:
 *   - Clean up existing resources before a fresh start.
 *   - Apply the product's k8s manifests with image tags rewritten to local builds.
 *   - Remove NetworkPolicies (studio needs unrestricted connectivity).
 *   - Poll workload health and render a per-service status dashboard.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from './spawn';
import type {
  StudioClusterConfig,
  K8sResource,
  ServiceHealth,
} from './types';
import type { ImageMap } from './image-builder';

// ── Cluster cleanup ──────────────────────────────────────────────────────────

/**
 * Delete all resources from a previous studio run.
 */
export function cleanupCluster(
  config: StudioClusterConfig,
  resources: K8sResource[],
): void {
  for (const r of resources) {
    spawn('kubectl', [
      'delete', r.kind.toLowerCase(), r.name,
      `--namespace=${config.namespace}`, '--ignore-not-found',
    ]);
  }

  spawn('kubectl', [
    'delete', 'pvc', '--all',
    `--namespace=${config.namespace}`, '--ignore-not-found',
  ]);

  spawn('kubectl', [
    'delete', 'pods', '--all',
    `--namespace=${config.namespace}`, '--grace-period=0',
  ]);
}

// ── Manifest application ─────────────────────────────────────────────────────

/**
 * Apply the product's k8s manifests with image tags rewritten to local builds.
 *
 * Reads all YAML files, replaces image references using the imageMap,
 * and pipes through kubectl apply. No kustomize needed.
 */
export function applyManifests(
  config: StudioClusterConfig,
  k8sDir: string,
  imageMap: ImageMap,
): void {
  // Apply all .yaml files except example/template files that aren't
  // real resources (e.g. secrets.example.yaml).
  const files = readdirSync(k8sDir)
    .filter((f) => f.endsWith('.yaml') && !f.includes('example'))
    .sort();

  let allYaml = '';

  for (const file of files) {
    let content = readFileSync(join(k8sDir, file), 'utf-8');

    // Rewrite image tags to local studio builds.
    // Handles angle-bracket placeholders like <owner> that appear in some
    // product k8s manifests (e.g. ghcr.io/<owner>/calypso-starter-ts:latest).
    // The regex escaping must also escape < and > so they are matched literally.
    // See: docs/cluster-definition.md — "Container image convention"
    for (const [original, studioTag] of Object.entries(imageMap)) {
      // Strip tag from original for the pattern (match any tag suffix).
      const base = original
        .replace(/:.*$/, '')
        .replace(/[.*+?^${}()|[\]\\<>]/g, '\\$&');
      content = content.replace(
        new RegExp(`(image:\\s*)${base}(:\\S+)?`, 'g'),
        `$1${studioTag}`,
      );
    }

    allYaml += content + '\n---\n';
  }

  if (config.verbose) {
    console.log(`    Applying ${files.length} manifest file(s)`);
  }

  // Pipe concatenated YAML into kubectl apply via the spawn wrapper's
  // stdin support. Previously this used two code paths (a dead spawn() call
  // and a direct Bun.spawnSync call). Now consolidated into a single path.
  // See: docs/cluster-definition.md — "Startup sequence" step 8.
  const result = spawn(
    'kubectl',
    ['apply', '-f', '-', `--namespace=${config.namespace}`],
    { cwd: config.sourceDir, input: allYaml },
  );

  if (result.status !== 0) {
    console.error('\n❌ kubectl apply failed');
    if (result.stderr) console.error(result.stderr.trim());
    if (result.stdout) console.error(result.stdout.trim());
    process.exit(result.status ?? 1);
  }

  if (config.verbose) {
    const stdout = result.stdout.trim();
    console.log(`    ${stdout.replace(/\n/g, '\n    ')}`);
  }
}

// ── Network policy removal ───────────────────────────────────────────────────

/**
 * Remove all NetworkPolicies from the studio cluster.
 */
export function removeNetworkPolicies(
  config: StudioClusterConfig,
  resources: K8sResource[],
): void {
  const policies = resources.filter((r) => r.kind === 'NetworkPolicy');
  for (const np of policies) {
    spawn('kubectl', [
      'delete', 'networkpolicy', np.name,
      `--namespace=${config.namespace}`, '--ignore-not-found',
    ]);
  }
}

// ── Health polling ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3_000;
const HEALTH_TIMEOUT_MS = 120_000;

/**
 * Get a human-readable pod status for pods matching a label selector.
 */
function getPodDetail(label: string, config: StudioClusterConfig): string {
  const result = spawn('kubectl', [
    'get', 'pods', '-l', label,
    `--namespace=${config.namespace}`,
    '-o', 'jsonpath={.items[0].status.phase}|{.items[0].status.containerStatuses[0].state.waiting.reason}|{.items[0].status.containerStatuses[0].state.terminated.reason}|{.items[0].status.containerStatuses[0].restartCount}',
  ]);

  if (result.status !== 0 || !result.stdout.trim()) return 'no pod';

  const [phase, waitingReason, terminatedReason, restarts] = result.stdout.split('|');
  const parts: string[] = [];
  if (phase) parts.push(phase.toLowerCase());
  if (waitingReason) parts.push(waitingReason);
  else if (terminatedReason) parts.push(terminatedReason);
  if (restarts && parseInt(restarts, 10) > 0) parts.push(`restarts=${restarts}`);
  return parts.join(', ') || 'unknown';
}

/**
 * Check health of a single workload.
 */
export function checkHealth(
  config: StudioClusterConfig,
  resource: K8sResource,
): ServiceHealth {
  const ns = `--namespace=${config.namespace}`;
  const base = { kind: resource.kind, name: resource.name };

  if (resource.kind === 'Deployment') {
    const result = spawn('kubectl', [
      'get', 'deployment', resource.name, ns,
      '-o', 'jsonpath={.status.availableReplicas}/{.spec.replicas}',
    ]);
    const [availStr, desiredStr] = (result.stdout || '/').split('/');
    const available = parseInt(availStr || '0', 10);
    const desired = parseInt(desiredStr || '0', 10);
    const ready = available >= desired && desired > 0;
    return {
      ...base, ready,
      detail: ready ? 'ready' : `${available}/${desired} available — ${getPodDetail(`app=${resource.name}`, config)}`,
    };
  }

  if (resource.kind === 'StatefulSet') {
    const result = spawn('kubectl', [
      'get', 'statefulset', resource.name, ns,
      '-o', 'jsonpath={.status.readyReplicas}/{.spec.replicas}',
    ]);
    const [readyStr, desiredStr] = (result.stdout || '/').split('/');
    const readyCount = parseInt(readyStr || '0', 10);
    const desired = parseInt(desiredStr || '0', 10);
    const ready = readyCount >= desired && desired > 0;
    return {
      ...base, ready,
      detail: ready ? 'ready' : `${readyCount}/${desired} ready — ${getPodDetail(`app=${resource.name}`, config)}`,
    };
  }

  if (resource.kind === 'Job') {
    const result = spawn('kubectl', [
      'get', 'job', resource.name, ns,
      '-o', 'jsonpath={.status.conditions[?(@.type=="Complete")].status}|{.status.conditions[?(@.type=="Failed")].status}',
    ]);
    const [complete, failed] = (result.stdout || '|').split('|');
    const isComplete = complete?.trim() === 'True';
    const isFailed = failed?.trim() === 'True';
    let detail = getPodDetail(`app=${resource.name}`, config);
    if (isComplete) detail = 'completed';
    else if (isFailed) detail = 'failed';
    return { ...base, ready: isComplete, detail };
  }

  return { ...base, ready: false, detail: 'unknown kind' };
}

/**
 * Wait for all discovered workloads to become healthy.
 *
 * Prints a per-service status dashboard every 3 seconds.
 * Times out after 120 seconds.
 */
export async function waitForHealthy(
  config: StudioClusterConfig,
  workloads: K8sResource[],
): Promise<void> {
  const startTime = Date.now();
  const deadline = startTime + HEALTH_TIMEOUT_MS;
  let tick = 0;

  while (Date.now() < deadline) {
    const statuses = workloads.map((w) => checkHealth(config, w));
    const allReady = statuses.every((s) => s.ready);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (tick > 0) console.log('');
    console.log(`\n  Cluster status (${elapsed}s):`);
    for (const s of statuses) {
      const icon = s.ready ? '✓' : '…';
      console.log(`    ${icon} ${s.kind}/${s.name}: ${s.detail}`);
    }

    if (allReady) return;

    tick++;
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  console.error('\n❌ Timed out waiting for cluster services.');
  const statuses = workloads.map((w) => checkHealth(config, w));
  for (const s of statuses) {
    const icon = s.ready ? '✓' : '✗';
    console.log(`    ${icon} ${s.kind}/${s.name}: ${s.detail}`);
  }
  process.exit(1);
}
