import path from "node:path";
import { describe, it } from "vitest";
import { runDeployCommand } from "../../commands/deploy.ts";

/**
 * E2E test for the deploy command.
 *
 * This test provisions a real k3d cluster, builds and pushes real Docker images,
 * applies Kubernetes manifests, and probes the ingress endpoint.
 *
 * Requires Docker, k3d, and kubectl to be installed and available in PATH.
 */

const FIXTURE_ROOT = path.resolve(
  import.meta.dirname,
  "../../../e2e/fixtures/hello-world"
);

describe("deploy command — full e2e", { timeout: 600_000 }, () => {
  it("provisions a k3d cluster and deploys the hello-world app", async () => {
    await runDeployCommand({ demoRoot: FIXTURE_ROOT });
    // If runDeployCommand completes without throwing, the deployment succeeded:
    // - Provision phase: docker, k3d, kubectl, and cluster ready
    // - Deploy phase: images built/pushed, manifests applied, all pods ready, ingress probed
  });
});
