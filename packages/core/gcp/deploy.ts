import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { googleJsonRequest } from "./http.js";
import type { SshTunnel } from "./ssh.js";
import { openSshTunnel } from "./ssh.js";
import { spawn } from "node:child_process";

export interface GcpDeployConfig {
  projectId: string;
  region: string;
  zone: string;
  vmName: string;
  alloydbClusterId: string;
  alloydbInstanceId: string;
  namespace: string;
  secretName: string;
  deploymentName: string;
  imageTag: string;
  deployScript: string;
  sshUser: string;
  sshKeyPath?: string;
  skipHttpCheck?: boolean;
  healthCheckPort?: number;
  talosMode?: boolean;
}

export interface GcpDeployDeps {
  googleJsonRequest: typeof googleJsonRequest;
  getAccessToken: () => Promise<string>;
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  exec: (
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string>; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  log: (msg: string) => void;
  isGitHubActions: boolean;
}

interface VmInstance {
  status?: string;
  networkInterfaces?: Array<{
    accessConfigs?: Array<{
      natIP?: string;
    }>;
  }>;
}

interface AlloyDbCluster {
  state?: string;
}

interface AlloyDbInstance {
  state?: string;
}

export async function runGcpDeploy(
  config: GcpDeployConfig,
  deps: GcpDeployDeps,
): Promise<void> {
  const {
    projectId,
    region,
    zone,
    vmName,
    alloydbClusterId,
    alloydbInstanceId,
    namespace,
    secretName,
    deploymentName,
    imageTag,
    deployScript,
    sshUser,
    sshKeyPath,
    skipHttpCheck,
    healthCheckPort = 31415,
    talosMode,
  } = config;

  const httpDeps = {
    fetch: deps.fetch,
    getAccessToken: deps.getAccessToken,
  };

  // Step 1: Verify VM is RUNNING
  deps.log(`Verifying VM ${vmName} is RUNNING...`);
  const vmData = await deps.googleJsonRequest<VmInstance>(
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${vmName}`,
    {},
    httpDeps,
  );

  if (!vmData || vmData.status !== "RUNNING") {
    throw new Error(
      `VM ${vmName} is not RUNNING (status: ${vmData?.status ?? "unknown"})`,
    );
  }

  const vmIp = vmData.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
  if (!vmIp) {
    throw new Error(`VM ${vmName} has no external IP address`);
  }
  deps.log(`VM ${vmName} is RUNNING at ${vmIp}`);

  // Step 2: Verify AlloyDB cluster READY
  deps.log(`Verifying AlloyDB cluster ${alloydbClusterId} is READY...`);
  const clusterData = await deps.googleJsonRequest<AlloyDbCluster>(
    `https://alloydb.googleapis.com/v1/projects/${projectId}/locations/${region}/clusters/${alloydbClusterId}`,
    {},
    httpDeps,
  );

  if (!clusterData || clusterData.state !== "READY") {
    throw new Error(
      `AlloyDB cluster ${alloydbClusterId} is not READY (state: ${clusterData?.state ?? "unknown"})`,
    );
  }
  deps.log(`AlloyDB cluster ${alloydbClusterId} is READY`);

  // Step 3: Verify AlloyDB instance READY
  deps.log(`Verifying AlloyDB instance ${alloydbInstanceId} is READY...`);
  const instanceData = await deps.googleJsonRequest<AlloyDbInstance>(
    `https://alloydb.googleapis.com/v1/projects/${projectId}/locations/${region}/clusters/${alloydbClusterId}/instances/${alloydbInstanceId}`,
    {},
    httpDeps,
  );

  if (!instanceData || instanceData.state !== "READY") {
    throw new Error(
      `AlloyDB instance ${alloydbInstanceId} is not READY (state: ${instanceData?.state ?? "unknown"})`,
    );
  }
  deps.log(`AlloyDB instance ${alloydbInstanceId} is READY`);

  // Step 4: Get kubeconfig
  let kubeconfigPath: string;
  let sshTunnel: SshTunnel | undefined;

  const kubeconfigFile = path.join(
    os.tmpdir(),
    `superfield-kubeconfig-${randomUUID()}.yaml`,
  );

  if (talosMode) {
    deps.log(`Getting kubeconfig via talosctl from ${vmIp}...`);
    const result = await deps.exec("talosctl", [
      "kubeconfig",
      "--nodes",
      vmIp,
      "--force",
      "-",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `talosctl kubeconfig failed (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
    fs.writeFileSync(kubeconfigFile, result.stdout, { mode: 0o600 });
    kubeconfigPath = kubeconfigFile;
  } else {
    deps.log(`Opening SSH tunnel to ${vmIp}:6443 for kubeconfig...`);
    sshTunnel = await openSshTunnel(
      {
        vmIp,
        user: sshUser,
        keyPath: sshKeyPath,
        remoteHost: "localhost",
        remotePort: 6443,
        localPort: 16443,
      },
      {
        spawn: (cmd, args, opts) =>
          spawn(cmd, args, { detached: opts?.detached ?? false }),
        log: deps.log,
      },
    );

    deps.log("Getting kubernetes service account token...");
    const tokenResult = await deps.exec(
      "kubectl",
      ["create", "token", "default", "--namespace", namespace],
      {
        env: {
          ...process.env,
          KUBECONFIG: "",
          KUBERNETES_SERVICE_HOST: `localhost`,
          KUBERNETES_SERVICE_PORT: `${sshTunnel.localPort}`,
        },
      },
    );
    if (tokenResult.exitCode !== 0) {
      throw new Error(
        `kubectl create token failed (exit ${tokenResult.exitCode}): ${tokenResult.stderr}`,
      );
    }
    const token = tokenResult.stdout.trim();

    const kubeconfigYaml = `apiVersion: v1
kind: Config
clusters:
- name: superfield
  cluster:
    server: https://localhost:${sshTunnel.localPort}
    insecure-skip-tls-verify: true
users:
- name: superfield
  user:
    token: ${token}
contexts:
- name: superfield
  context:
    cluster: superfield
    user: superfield
current-context: superfield
`;
    fs.writeFileSync(kubeconfigFile, kubeconfigYaml, { mode: 0o600 });
    kubeconfigPath = kubeconfigFile;
  }

  const kubectlEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as Array<
        [string, string]
      >,
    ),
    KUBECONFIG: kubeconfigPath,
  };

  try {
    // Step 5: Liveness checks
    deps.log(`Checking namespace ${namespace} exists...`);
    const nsResult = await deps.exec(
      "kubectl",
      ["get", "namespace", namespace],
      { env: kubectlEnv },
    );
    if (nsResult.exitCode !== 0) {
      throw new Error(
        `Namespace ${namespace} not found (exit ${nsResult.exitCode}): ${nsResult.stderr}`,
      );
    }

    deps.log(`Checking secret ${secretName} in namespace ${namespace}...`);
    const secretResult = await deps.exec(
      "kubectl",
      ["get", "secret", secretName, "--namespace", namespace],
      { env: kubectlEnv },
    );
    if (secretResult.exitCode !== 0) {
      throw new Error(
        `Secret ${secretName} not found in namespace ${namespace} (exit ${secretResult.exitCode}): ${secretResult.stderr}`,
      );
    }

    deps.log(
      `Checking rollout status of deployment/${deploymentName} in ${namespace}...`,
    );
    const rolloutResult = await deps.exec(
      "kubectl",
      [
        "rollout",
        "status",
        `deployment/${deploymentName}`,
        "--namespace",
        namespace,
        "--timeout=120s",
      ],
      { env: kubectlEnv },
    );
    if (rolloutResult.exitCode !== 0) {
      throw new Error(
        `Deployment ${deploymentName} rollout status check failed (exit ${rolloutResult.exitCode}): ${rolloutResult.stderr}`,
      );
    }

    // Step 6: Optional HTTP health check
    if (!skipHttpCheck) {
      const healthUrl = `http://${vmIp}:${healthCheckPort}/health`;
      deps.log(`HTTP health check: GET ${healthUrl}`);
      try {
        const healthResp = await deps.fetch(healthUrl);
        if (!healthResp.ok) {
          deps.log(
            `Warning: health check returned ${healthResp.status} ${healthResp.statusText}`,
          );
        } else {
          deps.log(`Health check passed (${healthResp.status})`);
        }
      } catch (err) {
        deps.log(
          `Warning: health check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 7: Deploy
    deps.log(`Running deploy script: ${deployScript} ${imageTag}`);
    const deployResult = await deps.exec(deployScript, [imageTag], {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([, v]) => v !== undefined,
          ) as Array<[string, string]>,
        ),
        KUBECONFIG: kubeconfigPath,
      },
    });
    if (deployResult.exitCode !== 0) {
      throw new Error(
        `Deploy script failed (exit ${deployResult.exitCode}): ${deployResult.stderr}`,
      );
    }
    deps.log("Deploy script completed successfully");

    // Step 8: Annotate deployment (GitHub Actions only)
    if (deps.isGitHubActions) {
      const runId = process.env["GITHUB_RUN_ID"];
      const actor = process.env["GITHUB_ACTOR"];
      if (runId && actor) {
        const timestamp = new Date().toISOString();
        deps.log(`Annotating deployment ${deploymentName}...`);
        await deps.exec(
          "kubectl",
          [
            "annotate",
            `deployment/${deploymentName}`,
            "--namespace",
            namespace,
            `deploy.superfield.ai/actor=${actor}`,
            `deploy.superfield.ai/run-id=${runId}`,
            `deploy.superfield.ai/image-tag=${imageTag}`,
            `deploy.superfield.ai/deployed-at=${timestamp}`,
            "--overwrite",
          ],
          { env: kubectlEnv },
        );
      }
    }
  } finally {
    // Step 9: Cleanup
    if (sshTunnel) {
      deps.log("Closing SSH tunnel...");
      sshTunnel.close();
    }
    try {
      fs.unlinkSync(kubeconfigFile);
    } catch {
      // ignore errors on cleanup
    }
  }
}
