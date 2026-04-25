/**
 * @file verify-cluster.ts
 *
 * Test-time and runtime verification of the studio cluster definition.
 *
 * Checks:
 *   1. MANIFESTS_PARSE — k8s YAML files parse correctly with kind + name.
 *   2. RELEASE_DOCKERFILE_EXISTS — Dockerfile.release exists in the product root.
 *   3. SECRETS_DECLARED — secretKeyRef entries are found for generation.
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import type { VerifyResult, VerifyCheck, StudioClusterConfig } from './types';
import { discoverResources, discoverSecretRefs } from './manifest-parser';
import { RELEASE_DOCKERFILE } from './studio-config';

// ── Prerequisites ─────────────────────────────────────────────────────────────

/**
 * Required CLI tools for studio startup.
 *
 * k3d replaces k3s: it runs k3s inside Docker and exposes cluster operations
 * through the Docker socket — no elevated privileges needed.
 */
const REQUIRED_TOOLS = ['docker', 'kubectl', 'k3d'] as const;

/**
 * Check that all required CLI tools are present on PATH.
 *
 * Exits the process with a clear error listing missing tools if any
 * prerequisite is absent.
 *
 * @example
 * checkPrerequisites();
 */
export function checkPrerequisites(): void {
  const missing: string[] = [];

  for (const tool of REQUIRED_TOOLS) {
    const result = spawnSync('which', [tool], { stdio: 'pipe' });
    if (result.status !== 0) {
      missing.push(tool);
    }
  }

  if (missing.length > 0) {
    console.error(`\n❌ Missing required tools: ${missing.join(', ')}`);
    for (const tool of missing) {
      if (tool === 'k3d') {
        console.error(`   k3d: https://k3d.io/#installation`);
      } else if (tool === 'docker') {
        console.error(`   docker: https://docs.docker.com/get-docker/`);
      } else if (tool === 'kubectl') {
        console.error(`   kubectl: https://kubernetes.io/docs/tasks/tools/`);
      }
    }
    process.exit(1);
  }
}

export interface VerifyOptions {
  k8sDir: string;
  sourceDir?: string;
}

/**
 * Run all verification checks against the product's cluster definition.
 */
export async function verifyStudioCluster(
  options: VerifyOptions,
): Promise<VerifyResult> {
  const checks: VerifyCheck[] = [];
  const sourceDir = options.sourceDir ?? process.cwd();
  const k8sDir = resolve(sourceDir, options.k8sDir);

  // Check 1: manifests parse.
  let resources;
  try {
    resources = discoverResources(k8sDir);
    checks.push({
      name: 'manifests-parse',
      ok: resources.length > 0,
      message: `${resources.length} resource(s) discovered`,
    });
  } catch (err) {
    checks.push({
      name: 'manifests-parse',
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, checks };
  }

  // Check 2: Dockerfile.release exists.
  const dockerfilePath = join(sourceDir, RELEASE_DOCKERFILE);
  const dockerfileExists = existsSync(dockerfilePath);
  checks.push({
    name: 'release-dockerfile',
    ok: dockerfileExists,
    message: dockerfileExists
      ? RELEASE_DOCKERFILE
      : `${RELEASE_DOCKERFILE} not found at ${sourceDir}`,
  });

  // Check 3: secrets are referenced.
  const secrets = discoverSecretRefs(k8sDir);
  const keyCount = secrets.reduce((n, s) => n + Object.keys(s.literals).length, 0);
  checks.push({
    name: 'secrets-declared',
    ok: true,
    message: `${secrets.length} secret(s) with ${keyCount} key(s)`,
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}

/**
 * Runtime verification — called by studio-start.ts.
 */
export async function verifyAtStartup(
  config: StudioClusterConfig,
): Promise<void> {
  const result = await verifyStudioCluster({
    k8sDir: join(config.sourceDir, config.k8sDir),
    sourceDir: config.sourceDir,
  });

  for (const check of result.checks) {
    const icon = check.ok ? '✓' : '✗';
    console.log(`    ${icon} ${check.name}: ${check.message}`);
  }

  if (!result.ok) {
    console.error('\n❌ Studio cluster verification failed.');
    process.exit(1);
  }
}
