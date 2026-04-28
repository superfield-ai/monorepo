/**
 * @file local-deploy.ts
 *
 * Unified local cluster deploy / teardown path for all Superfield apps.
 *
 * Replaces the per-app `scripts/local-demo.ts` contract. Any app with a
 * `k8s/` directory and a `Dockerfile.release` can be deployed without any
 * app-specific glue scripts.
 *
 * Used by:
 *   - `superfield deploy --path <dir>` (CLI)
 *   - `POST /studio/rebuild` (control webapp)
 */

import { join } from "path";
import { checkPrerequisites } from "./verify-cluster";
import {
  discoverResources,
  discoverImages,
  discoverSecretRefs,
} from "./manifest-parser";
import { buildImages } from "./image-builder";
import {
  cleanupCluster,
  applyManifests,
  waitForHealthy,
} from "./cluster-manager";
import { generateSecrets, applySecrets } from "./secret-generator";
import type { StudioClusterConfig } from "./types";

export interface LocalDeployOpts {
  /** Absolute path to the app root (contains k8s/ and Dockerfile.release). */
  appRoot: string;
  /** kubectl namespace. Defaults to "default". */
  namespace?: string;
  /** Enable verbose diagnostic logging. */
  verbose?: boolean;
}

function makeConfig(opts: LocalDeployOpts): StudioClusterConfig {
  return {
    sourceDir: opts.appRoot,
    k8sDir: "k8s",
    namespace: opts.namespace ?? "default",
    verbose: opts.verbose ?? false,
  };
}

/**
 * Fully provision and deploy an app to the local k3d cluster.
 *
 * Steps:
 *   1. Check docker / k3d / kubectl prerequisites
 *   2. Discover k8s resources and images from <appRoot>/k8s/
 *   3. Build Dockerfile.release and import into k3d
 *   4. Delete any existing cluster resources
 *   5. Discover, generate, and apply secrets
 *   6. Apply k8s manifests with the built image tag
 *   7. Wait for all workloads to become healthy
 */
export async function deployLocalCluster(opts: LocalDeployOpts): Promise<void> {
  const config = makeConfig(opts);
  const k8sDir = join(opts.appRoot, "k8s");

  checkPrerequisites();

  const resources = discoverResources(k8sDir);
  const images = discoverImages(k8sDir);
  const imageMap = buildImages(config, images);

  cleanupCluster(config, resources);

  const secretSpecs = discoverSecretRefs(k8sDir);
  const filledSecrets = generateSecrets(secretSpecs);
  applySecrets(config, filledSecrets);

  applyManifests(config, k8sDir, imageMap);

  const workloads = resources.filter((r) =>
    ["Deployment", "StatefulSet", "Job"].includes(r.kind),
  );
  await waitForHealthy(config, workloads);
}

/**
 * Tear down the local cluster for an app.
 *
 * Deletes all k8s resources discovered from <appRoot>/k8s/.
 */
export function teardownLocalCluster(opts: LocalDeployOpts): void {
  const config = makeConfig(opts);
  const k8sDir = join(opts.appRoot, "k8s");
  const resources = discoverResources(k8sDir);
  cleanupCluster(config, resources);
}
