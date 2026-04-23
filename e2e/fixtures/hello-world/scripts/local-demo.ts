import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const CLUSTER_NAME = "superfield-e2e";
const REGISTRY_NAME = "superfield-reg";
const REGISTRY_K3D_NAME = `k3d-${REGISTRY_NAME}`;

// When running inside a container (e.g. CI runner with Docker socket mounted),
// k3d creates a kubeconfig with server=https://0.0.0.0:PORT which resolves to
// the container's own loopback rather than the host. We detect this and patch
// the kubeconfig to use the host's gateway IP instead.
function getHostGatewayIp(): string | null {
  if (!existsSync("/.dockerenv")) return null;
  try {
    const out = execFileSync("sh", [
      "-c",
      "ip route show default | awk 'NR==1{print $3}'",
    ], { encoding: "utf8" });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Ensures the k3d cluster and local registry exist and are ready.
 * Idempotent: safe to run multiple times.
 */
export async function ensureCluster(): Promise<void> {
  const hostGateway = getHostGatewayIp();

  // Create registry (idempotent)
  spawnSync("k3d", ["registry", "create", REGISTRY_NAME, "--port", "5000"], {
    stdio: "pipe",
  });

  // Build cluster args; when inside a container add the host gateway as a TLS
  // SAN so kubectl can verify the cert via the patched server address below.
  const clusterArgs = [
    "cluster",
    "create",
    CLUSTER_NAME,
    `--registry-use=${REGISTRY_K3D_NAME}:5000`,
    "--port=58080:80@loadbalancer",
    "--wait",
  ];
  if (hostGateway) {
    clusterArgs.push(`--k3s-arg=--tls-san=${hostGateway}@server:0`);
  }

  spawnSync("k3d", clusterArgs, { stdio: "pipe" });

  // Always explicitly fetch the kubeconfig — k3d won't re-merge it if the
  // cluster already existed, so we can't rely on ~/.kube/config being current.
  const kubeconfigResult = spawnSync(
    "k3d",
    ["kubeconfig", "get", CLUSTER_NAME],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  if (kubeconfigResult.stdout) {
    let kubeconfig = kubeconfigResult.stdout;
    // Replace 0.0.0.0 with the host gateway so kubectl can reach the API
    // server from inside the CI runner container.
    if (hostGateway) {
      kubeconfig = kubeconfig.replace(
        /https:\/\/0\.0\.0\.0:(\d+)/g,
        `https://${hostGateway}:$1`,
      );
    }
    const kubeconfigDir = path.join(homedir(), ".kube");
    mkdirSync(kubeconfigDir, { recursive: true });
    writeFileSync(path.join(kubeconfigDir, "config"), kubeconfig, "utf8");
  }

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
