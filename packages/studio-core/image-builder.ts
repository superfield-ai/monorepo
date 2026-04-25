/**
 * @file image-builder.ts
 *
 * Builds the product's container image from Dockerfile.release.
 *
 * Studio uses the same Dockerfile that CI uses for releases. This is the
 * core of the isomorphic deployment guarantee — the container running in
 * studio is the same artifact that would run in staging or production.
 *
 * Convention:
 *   - All k8s workloads reference the same release image (with different
 *     commands/entrypoints for app vs workers).
 *   - That image is built from `Dockerfile.release` at the product root.
 *   - Third-party images (e.g. postgres:16-alpine) are used as-is.
 *
 * Docker layer caching makes rebuilds fast — typically only the final
 * build + COPY steps re-run, taking 2–5 seconds.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from './spawn';
import { RELEASE_DOCKERFILE } from './studio-config';
import type { StudioClusterConfig } from './types';

/** Map of original image reference → locally-built studio tag. */
export type ImageMap = Record<string, string>;

/** Studio tag for locally-built images. */
const STUDIO_TAG = 'calypso-release:studio';

/**
 * Build the product's release image and return the image map.
 *
 * Discovers all unique image references from the k8s manifests, identifies
 * which ones are product images (have a matching Dockerfile.release), and
 * builds a single image that all product workloads share.
 *
 * Third-party images (e.g. postgres:16-alpine) that don't have a Dockerfile
 * in the product repo are skipped — they're pulled from upstream.
 *
 * @param config  Studio cluster configuration.
 * @param images  Unique image references discovered from k8s manifests.
 * @returns       Map of product image references → local studio tag.
 */
export function buildImages(
  config: StudioClusterConfig,
  images: string[],
): ImageMap {
  const dockerfile = join(config.sourceDir, RELEASE_DOCKERFILE);

  if (!existsSync(dockerfile)) {
    console.error(`\n❌ ${RELEASE_DOCKERFILE} not found at ${config.sourceDir}`);
    process.exit(1);
  }

  // Build once. Use stream:true so docker build output is visible in real
  // time — without this, the terminal appears frozen for the full build
  // duration (5–15 min cold, ~30s warm) with no progress shown.
  console.log(`  Building ${STUDIO_TAG} from ${RELEASE_DOCKERFILE}...`);
  const result = spawn('docker', [
    'build',
    '-f', dockerfile,
    '-t', STUDIO_TAG,
    config.sourceDir,
  ], { stream: true });

  if (result.status !== 0) {
    console.error(`\n❌ Docker build failed`);
    process.exit(1);
  }

  // Import into the k3d cluster so workloads can pull the local image.
  importToK3d(STUDIO_TAG, config);

  // Map all product image references to the single studio tag.
  // Third-party images (no ghcr.io or <owner> in the reference, or images
  // like postgres:16-alpine) are skipped.
  const imageMap: ImageMap = {};
  for (const image of images) {
    if (isProductImage(image)) {
      imageMap[image] = STUDIO_TAG;
    } else if (config.verbose) {
      console.log(`  Skipping ${image} (third-party — using upstream)`);
    }
  }

  return imageMap;
}

/**
 * Rebuild the release image after a code change and restart deployments.
 *
 * Called during a studio session when Claude makes source changes.
 */
export function rebuildAndRestart(config: StudioClusterConfig): void {
  const dockerfile = join(config.sourceDir, RELEASE_DOCKERFILE);

  console.log(`  Rebuilding ${STUDIO_TAG}...`);
  const result = spawn('docker', [
    'build', '-f', dockerfile, '-t', STUDIO_TAG, config.sourceDir,
  ], { stream: true });

  if (result.status !== 0) {
    console.error('  Rebuild failed');
    return;
  }

  importToK3d(STUDIO_TAG, config);

  // Restart all deployments so they pick up the new image.
  spawn('kubectl', [
    'rollout', 'restart', 'deployment', '--all',
    `--namespace=${config.namespace}`,
  ]);
}

/**
 * Import a locally-built Docker image into the k3d cluster.
 *
 * k3d (k3s-in-Docker) exposes cluster operations through the Docker socket,
 * which developers already have access to. This requires no elevated privileges
 * unlike the previous `sudo k3s ctr images import` approach.
 *
 * `k3d image import` loads the image directly from Docker's image store into
 * the k3d cluster nodes — no intermediate tar file needed.
 */
function importToK3d(tag: string, config: StudioClusterConfig): void {
  if (config.verbose) {
    console.log(`  Importing ${tag} into k3d cluster...`);
  }

  const importResult = spawn('k3d', ['image', 'import', tag]);

  if (importResult.status !== 0) {
    throw new Error(
      `k3d image import failed (exit ${importResult.status}).\n` +
      `  Ensure k3d is installed and a k3d cluster is running.\n` +
      `  Install k3d: https://k3d.io/#installation\n` +
      `  Create a cluster: k3d cluster create studio`,
    );
  }
}

/**
 * Determine if an image reference is a product image (built from the
 * product repo) or a third-party upstream image.
 *
 * Product images contain registry paths with owner prefixes (ghcr.io/...)
 * or placeholder patterns (<owner>). Third-party images are bare names
 * with no registry prefix (e.g. postgres:16-alpine) or well-known
 * registries (docker.io, etc.).
 */
function isProductImage(image: string): boolean {
  // Images with <owner> placeholders are product images.
  if (image.includes('<owner>')) return true;
  // Images with ghcr.io are product images.
  if (image.includes('ghcr.io')) return true;
  // Bare images without a slash are third-party (e.g. postgres:16-alpine).
  if (!image.includes('/')) return false;
  // docker.io official images.
  if (image.startsWith('docker.io/')) return false;
  // Anything else with a registry prefix is likely product.
  return true;
}
