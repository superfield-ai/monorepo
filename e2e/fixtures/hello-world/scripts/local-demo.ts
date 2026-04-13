import { spawnSync } from "node:child_process";

const CLUSTER_NAME = "superfield-e2e";
const REGISTRY_NAME = "k3d-superfield-reg";

/**
 * Ensures the k3d cluster and local registry exist and are ready.
 * Idempotent: safe to run multiple times.
 */
export async function ensureCluster(): Promise<void> {
  // Create registry (idempotent)
  spawnSync("k3d", ["registry", "create", REGISTRY_NAME, "--port", "5000"], {
    stdio: "pipe",
  });

  // Create cluster with registry integration (idempotent)
  spawnSync(
    "k3d",
    [
      "cluster",
      "create",
      CLUSTER_NAME,
      `--registry-use=${REGISTRY_NAME}:5000`,
      "--port=58080:80@loadbalancer",
      "--wait",
    ],
    { stdio: "pipe" },
  );

  // Verify cluster is accessible
  spawnSync("kubectl", ["--context", `k3d-${CLUSTER_NAME}`, "cluster-info"], {
    stdio: "inherit",
  });
}
