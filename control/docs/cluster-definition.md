# Studio Cluster Definition

Studio brings up a local k3s cluster that mirrors a product's production
topology. It reads the product's existing Kubernetes manifests and builds
containers from the same `Dockerfile.release` that CI uses for production
releases.

## Design principle: isomorphic deployments

Studio runs the **exact same containers** that staging, demo, and production
run. There is no hot-reload layer, no volume mounting, no binary staging
directory, and no divergence between what the container was built with and
what it is running.

When Claude makes a code change in a studio session, studio:

1. Rebuilds the container image from `Dockerfile.release`.
2. Tags it locally and imports it into k3s.
3. Does a `kubectl rollout restart` on the affected deployments.

This is slightly slower than hot-reloading a binary (a few extra seconds for
Docker layer cache to replay the final build step). But the tradeoff is worth
it:

- **No divergence.** The container running in studio is byte-for-byte the
  same artifact that would run in staging or production.
- **No volume mounts.** No hostPath, no staging directory, no path rewriting.
- **No kustomize overlays.** The product's k8s manifests are applied directly
  — the only change is the image tag.
- **No configuration files.** No `studio.yaml`, no image→Dockerfile mappings.
  Studio discovers everything from conventions and the existing repo structure.

## What studio needs to know

Studio requires exactly two inputs:

### 1. Product source directory

The root of the product repository. Studio passes this path to Claude so it
can create worktrees, edit code, and rebuild images. The directory itself
always tracks an up-to-date `main` — Claude creates throwaway worktrees for
session branches.

```
bun run studio /path/to/product
```

Default: the parent of the studio submodule directory.

### 2. Kubernetes deployment path

The directory containing the product's Kubernetes YAML files.

```
bun run studio /path/to/product k8s/custom-dir
```

Default: `k8s/` relative to the product source directory.

## Container image convention

Studio uses `Dockerfile.release` at the product root to build the production
container image. This is the same Dockerfile that CI uses for releases.

All k8s workloads (app, workers, db-init) reference the same image — they
differentiate by `command:` overrides in their pod specs, not by separate
images. Studio builds this image once, tags it as `calypso-release:studio`,
and rewrites all matching image references in the k8s manifests.

Third-party images (e.g. `postgres:16-alpine`) are used as-is from upstream.
Studio identifies product images by their registry prefix (`ghcr.io/...`).

### What studio ignores

- **`docker-compose.yml`** — used for test-time containers only. It references
  `Dockerfile.dev` and `Dockerfile.worker.dev` which volume-mount source code
  for hot-reload. Studio does not use these.
- **`Dockerfile.dev` / `Dockerfile.worker.dev`** — dev-time variants that are
  not isomorphic with production. Studio ignores them.
- **`Dockerfile` / `Dockerfile.worker`** — earlier Dockerfile variants that
  may exist in the repo. Studio uses `Dockerfile.release` exclusively.

## Verification

Studio verifies the cluster definition at both test time and runtime.

### Test-time checks

```typescript
import { verifyStudioCluster } from 'studio/packages/core/verify-cluster';

test('studio cluster definition is valid', async () => {
  const result = await verifyStudioCluster({ k8sDir: 'k8s/' });
  expect(result.ok).toBe(true);
});
```

This verifies:

- **Manifests parse** — every YAML file in the k8s directory is valid and
  contains `kind` + `metadata.name`.
- **Dockerfile.release exists** — the production Dockerfile is present in the
  product root.
- **Secrets are declared** — every `secretKeyRef` in the manifests references
  a Secret name, ensuring studio can generate ephemeral values.

### Runtime checks

When `bun run studio` starts, it runs the same verification checks before
any cluster operations begin. Build failures surface immediately.

## Startup sequence

1. **Prerequisites** — verify bun, k3s, kubectl, docker are on PATH.
2. **Uncommitted changes** — warn (non-blocking) if the product repo has
   uncommitted changes.
3. **Validate** — parse k8s manifests, verify `Dockerfile.release` exists.
4. **Discover** — extract resources, secret references, and image references
   from the k8s YAML files.
5. **Build image** — `docker build -f Dockerfile.release` → tag as
   `calypso-release:studio` → import into k3s.
6. **Generate secrets** — create ephemeral values for each `secretKeyRef`
   discovered in the manifests.
7. **Clean up** — delete existing resources from any previous studio run.
8. **Apply manifests** — `kubectl apply` the product's k8s files with image
   tags rewritten to the local build.
9. **Remove network policies** — studio needs unrestricted pod-to-pod
   connectivity.
10. **Seed data** — insert dummy worker credentials into the database so
    workers can start.
11. **Health wait** — poll each discovered workload until all are healthy,
    printing a per-service dashboard every 3 seconds.
12. **Start server** — print the startup banner and bring up the studio
    HTTP server for the browser UI.

On a code change during a session:

1. **Rebuild** — `docker build -f Dockerfile.release` (layer cache handles
   the unchanged layers — typically 2–5 seconds).
2. **Import** — pipe the image into k3s containerd.
3. **Restart** — `kubectl rollout restart deployment --all`.
4. **Wait** — poll until healthy.

## What lives where

```
product-repo/
  k8s/                    # production k8s manifests (single source of truth)
    app.yaml
    postgres.yaml
    worker-agents.yaml
    db-init-job.yaml
  Dockerfile.release      # production container image (used by CI and studio)
  Dockerfile.dev          # dev-time only (studio ignores)
  docker-compose.yml      # test-time only (studio ignores)

  studio/                 # studio submodule (generic, app-agnostic)
    scripts/
      studio-start.ts     # reads product k8s, builds image, applies, monitors
    packages/core/
      manifest-parser.ts  # parse k8s YAML → resources, secrets, images
      image-builder.ts    # docker build from Dockerfile.release
      secret-generator.ts # generate ephemeral secrets from manifest refs
      cluster-manager.ts  # apply, cleanup, health-poll
      verify-cluster.ts   # test-time + runtime verification
      studio-config.ts    # conventions documentation (no config file)
    apps/server/           # studio HTTP server (proxy, chat, SSE)
    docs/                  # this document
```

Studio knows how to build one image, apply manifests, generate secrets, and
monitor health. The product defines what to deploy. No mapping files, no
overlays, no configuration.
