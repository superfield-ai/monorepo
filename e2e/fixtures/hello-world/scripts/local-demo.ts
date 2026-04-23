import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const CLUSTER_NAME = "superfield-e2e";
const REGISTRY_NAME = "superfield-reg";
const REGISTRY_K3D_NAME = `k3d-${REGISTRY_NAME}`;

// When running inside a CI container (Docker socket mounted), k3d creates a
// kubeconfig with server=https://0.0.0.0:PORT. From inside the container
// 0.0.0.0 resolves to the container's own loopback rather than the host.
// Read the default gateway from /proc/net/route (always available on Linux,
// no external tools required) and use it as the server address instead.
function getHostGatewayIp(): string | null {
  if (!process.env.GITHUB_ACTIONS) return null;
  try {
    const route = readFileSync("/proc/net/route", "utf8");
    for (const line of route.split("\n").slice(1)) {
      const parts = line.split("\t");
      // Destination "00000000" = default route; gateway is parts[2] in
      // little-endian hex (e.g. "0101A8C0" = 192.168.1.1)
      if (parts.length > 2 && parts[1] === "00000000") {
        const hex = parts[2];
        const ip = [6, 4, 2, 0]
          .map((i) => parseInt(hex.slice(i, i + 2), 16))
          .join(".");
        return ip || null;
      }
    }
  } catch (_e) {
    // /proc/net/route unavailable; gateway detection skipped
  }
  return null;
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

  // Build cluster args; when inside a CI container add the host gateway as a
  // TLS SAN so kubectl can verify the cert via the patched server address.
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

  // Always explicitly fetch the kubeconfig — k3d won't re-merge it when the
  // cluster already exists, so we can't rely on ~/.kube/config being current.
  const kubeconfigResult = spawnSync(
    "k3d",
    ["kubeconfig", "get", CLUSTER_NAME],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  if (kubeconfigResult.stdout) {
    let kubeconfig = kubeconfigResult.stdout;
    // Replace 0.0.0.0 with the host gateway so kubectl can reach the API
    // server from inside the CI container. Also replace the TLS cert
    // reference with insecure-skip-tls-verify — the k3s cert may not
    // include the host gateway IP in its SANs (especially on re-used
    // clusters), so skip verification for CI e2e tests.
    if (hostGateway) {
      kubeconfig = kubeconfig
        .replace(/https:\/\/0\.0\.0\.0:(\d+)/g, `https://${hostGateway}:$1`)
        .replace(
          /^\s+certificate-authority-data: .+$/m,
          "    insecure-skip-tls-verify: true",
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
