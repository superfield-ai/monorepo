/**
 * @file studio-config.ts
 *
 * Studio configuration conventions.
 *
 * Studio does not require a configuration file. It uses conventions:
 *
 *   - `Dockerfile.release` is the production container image. Studio builds
 *     from this Dockerfile to ensure isomorphic deployments.
 *   - `docker-compose.yml` is for test-time containers only. Studio ignores it.
 *   - `Dockerfile.dev` / `Dockerfile.worker.dev` are dev-time variants that
 *     volume-mount source for hot-reload. Studio ignores them.
 *   - `k8s/` contains production Kubernetes manifests. Studio applies these
 *     directly with the image tag rewritten to the locally-built image.
 *
 * The binding between k8s manifests and the Dockerfile is structural:
 *   - All workloads in the k8s manifests reference the same release image
 *     (e.g. `ghcr.io/<owner>/calypso-starter-ts:latest`).
 *   - That image is built from `Dockerfile.release`.
 *   - Workers use the same image with a different command/entrypoint.
 *
 * Studio discovers this automatically — no studio.yaml or image mapping
 * file is needed.
 */

export const RELEASE_DOCKERFILE = 'Dockerfile.release';

/**
 * Files that studio ignores — these are for test-time or dev-time only,
 * not for isomorphic studio clusters.
 */
export const IGNORED_FILES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'Dockerfile.dev',
  'Dockerfile.worker.dev',
];
