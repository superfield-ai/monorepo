import { spawnSync } from "node:child_process";

const CLUSTER_NAME = "superfield-e2e";
const REGISTRY_NAME = "superfield-reg";
const REGISTRY_K3D_NAME = `k3d-${REGISTRY_NAME}`;

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
      `--registry-use=${REGISTRY_K3D_NAME}:5000`,
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

export async function destroyCluster(): Promise<void> {
  spawnSync("k3d", ["cluster", "delete", CLUSTER_NAME], { stdio: "inherit" });
  spawnSync("k3d", ["registry", "delete", REGISTRY_K3D_NAME], {
    stdio: "inherit",
  });
}
