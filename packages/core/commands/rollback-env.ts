import { SshClient } from "../ssh/client.ts";
import { getAuthToken } from "../github/auth.ts";
import {
  SshKubeRunner,
  type KubeRunner,
} from "./deploy-env.ts";

/**
 * Options for {@link rollbackEnv}.
 *
 * Mirrors the SSH/runtime shape of `deployEnv` so operators can drive a
 * rollback with the same environment they use for deploys.
 */
export interface RollbackEnvOptions {
  /** owner/name */
  repo: string;
  env: string;
  appName: string;
  workerNames?: string[];
  /** default "/healthz" */
  healthPath?: string;
  /** default "default" */
  appNamespace?: string;
  /** VM SSH host */
  host: string;
  /** default "root" */
  sshUser?: string;
  /** PEM bytes of the deploy private key */
  sshPrivateKeyPem: string;
  knownHostsPath: string;
  onLog?: (line: string) => void;
  deps?: {
    githubFetch?: typeof fetch;
    githubToken?: string;
    /** Override the kubectl execution path (test seam). */
    runner?: KubeRunner;
    /** Override the SSH tunnel path (test seam). */
    openTunnel?: () => Promise<{ close: () => Promise<void> }>;
    /** Override the host-key trust step (test seam). */
    trustHostKey?: () => Promise<void>;
  };
}

export interface RollbackEnvResult {
  /** deployment name → restored image digest (full `repo@sha256:…` reference) */
  rolledBackTo: Record<string, string>;
  healthy: boolean;
}

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_RETRY_INTERVAL_MS = 2_000;
const ROLLOUT_TIMEOUT = "5m";

function ts(): string {
  return new Date().toISOString();
}

function makeLog(onLog?: (line: string) => void): (line: string) => void {
  return (line: string) => {
    const stamped = `[${ts()}] ${line}`;
    if (onLog) onLog(stamped);
    else process.stdout.write(stamped + "\n");
  };
}

interface DeploymentRecord {
  id: number;
}

async function createGithubDeployment(opts: {
  repo: string;
  env: string;
  ref: string;
  fetchImpl: typeof fetch;
  token: string;
}): Promise<DeploymentRecord | null> {
  const url = `https://api.github.com/repos/${opts.repo}/deployments`;
  const res = await opts.fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: opts.ref,
      environment: opts.env,
      auto_merge: false,
      required_contexts: [],
      description: "superfield rollback-env",
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as DeploymentRecord;
  return body;
}

async function createDeploymentStatus(opts: {
  repo: string;
  deploymentId: number;
  state: "success" | "failure" | "in_progress";
  description: string;
  fetchImpl: typeof fetch;
  token: string;
}): Promise<void> {
  const url =
    `https://api.github.com/repos/${opts.repo}/deployments/${opts.deploymentId}/statuses`;
  await opts.fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      state: opts.state,
      description: opts.description,
    }),
  });
}

class RollbackStepError extends Error {
  constructor(readonly step: string, message: string) {
    super(`[${step}] ${message}`);
    this.name = "RollbackStepError";
  }
}

/**
 * Operator-driven rollback for the application + workers on a provisioned VM.
 *
 * High-level flow:
 *   1. Open SSH (trust host key first contact); open k8s API tunnel
 *   2. For app + each worker, sequentially:
 *        kubectl rollout undo deployment/<name>
 *        kubectl rollout status deployment/<name> --timeout=5m
 *        capture restored image (`get deployment/<name> -o jsonpath=…`)
 *   3. Health gate via in-cluster curl through `kubectl run --rm`
 *   4. On health failure: do NOT roll forward — return `{ healthy: false }`
 *      with `rolledBackTo` populated so callers can inspect.
 *   5. On any other step failure (undo, status, get): throw with the step name.
 *   6. Annotate the GitHub deployment (best effort).
 */
export async function rollbackEnv(
  opts: RollbackEnvOptions,
): Promise<RollbackEnvResult> {
  const log = makeLog(opts.onLog);
  const env = opts.env;
  const appNamespace = opts.appNamespace ?? "default";
  const healthPath = opts.healthPath ?? "/healthz";
  const sshUser = opts.sshUser ?? "root";
  const workerNames = opts.workerNames ?? [];

  log(`rollback-env starting: repo=${opts.repo} env=${env}`);

  // GitHub token — best-effort for the deployment annotation only.
  const githubToken =
    opts.deps?.githubToken
    ?? (await getAuthToken().catch(() => ""));

  // ── Step 1: open SSH + tunnel ───────────────────────────────────────────
  const ssh = new SshClient({
    host: opts.host,
    user: sshUser,
    privateKeyPem: opts.sshPrivateKeyPem,
    knownHostsPath: opts.knownHostsPath,
  });

  if (opts.deps?.trustHostKey) {
    await opts.deps.trustHostKey();
  } else {
    await ssh.trustHostKey();
  }
  log(`trusted host key for ${opts.host}`);

  const tunnel = opts.deps?.openTunnel
    ? await opts.deps.openTunnel()
    : await ssh.tunnel(6443, await randomLocalPort());
  log(`opened k8s API tunnel to ${opts.host}:6443`);

  const runner: KubeRunner = opts.deps?.runner ?? new SshKubeRunner(ssh);

  const githubFetch = opts.deps?.githubFetch ?? globalThis.fetch;
  let deployment: DeploymentRecord | null = null;
  if (githubToken) {
    try {
      deployment = await createGithubDeployment({
        repo: opts.repo,
        env,
        ref: env,
        fetchImpl: githubFetch,
        token: githubToken,
      });
      if (deployment) log(`created GitHub deployment ${deployment.id}`);
    } catch (err) {
      log(
        `warning: failed to create GitHub deployment record: ${(err as Error).message}`,
      );
    }
  }

  const annotateOutcome = async (
    state: "success" | "failure",
    description: string,
  ): Promise<void> => {
    if (!deployment || !githubToken) {
      log(`outcome=${state} (no deployment record to annotate)`);
      return;
    }
    try {
      await createDeploymentStatus({
        repo: opts.repo,
        deploymentId: deployment.id,
        state,
        description,
        fetchImpl: githubFetch,
        token: githubToken,
      });
    } catch (err) {
      log(
        `warning: failed to update deployment status: ${(err as Error).message}`,
      );
    }
  };

  const rolledBackTo: Record<string, string> = {};

  try {
    // ── Step 2: rollback app + workers, sequentially ─────────────────────
    for (const name of [opts.appName, ...workerNames]) {
      const stepBase = name === opts.appName ? "app" : `worker:${name}`;

      log(`rolling back deployment/${name}`);
      const undo = await runner.exec(
        `kubectl rollout undo -n ${appNamespace} deployment/${name}`,
      );
      if (undo.exitCode !== 0) {
        throw new RollbackStepError(
          `${stepBase}-rollout-undo`,
          `kubectl rollout undo failed for ${name}: ${undo.stderr.trim() || undo.stdout.trim()}`,
        );
      }

      log(`waiting for rollout of deployment/${name}`);
      const status = await runner.exec(
        `kubectl rollout status -n ${appNamespace} deployment/${name} --timeout=${ROLLOUT_TIMEOUT}`,
      );
      if (status.exitCode !== 0) {
        throw new RollbackStepError(
          `${stepBase}-rollout-status`,
          `rollout status failed for ${name}: ${status.stderr.trim() || status.stdout.trim()}`,
        );
      }

      const get = await runner.exec(
        `kubectl get -n ${appNamespace} deployment/${name} -o jsonpath='{.spec.template.spec.containers[0].image}'`,
      );
      if (get.exitCode !== 0) {
        throw new RollbackStepError(
          `${stepBase}-get-image`,
          `kubectl get failed for ${name}: ${get.stderr.trim() || get.stdout.trim()}`,
        );
      }
      const image = get.stdout.trim().replace(/^'|'$/g, "");
      rolledBackTo[name] = image;
      log(`restored deployment/${name} → ${image}`);
    }

    // ── Step 3: health gate ──────────────────────────────────────────────
    log(
      `health-checking http://${opts.appName}.${appNamespace}.svc.cluster.local${healthPath}`,
    );
    const healthy = await healthGate({
      runner,
      appName: opts.appName,
      namespace: appNamespace,
      healthPath,
      log,
    });
    if (!healthy) {
      // Per spec: do NOT roll forward. Return with rolledBackTo populated.
      log(
        `health check failed after rollback; not rolling forward — operator must investigate`,
      );
      await annotateOutcome(
        "failure",
        `rollback completed but health check failed`,
      );
      return { rolledBackTo, healthy: false };
    }
    log(`health check passed`);

    await annotateOutcome("success", `rolled back env=${env}`);
    log(`rollback-env complete`);
    return { rolledBackTo, healthy: true };
  } catch (err) {
    const stepErr = err instanceof RollbackStepError ? err : null;
    const failingStep = stepErr?.step ?? "unknown";
    const message = (err as Error).message;
    log(`rollback-env failed at step=${failingStep}: ${message}`);
    await annotateOutcome("failure", `failed at ${failingStep}: ${message}`);
    throw err;
  } finally {
    try {
      await tunnel.close();
    } catch {
      // best effort
    }
  }
}

async function healthGate(opts: {
  runner: KubeRunner;
  appName: string;
  namespace: string;
  healthPath: string;
  log: (line: string) => void;
}): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  const url = `http://${opts.appName}.${opts.namespace}.svc.cluster.local${opts.healthPath}`;
  while (Date.now() < deadline) {
    const probeName = `sf-health-${Date.now().toString(36)}`;
    const cmd =
      `kubectl run ${probeName} -n ${opts.namespace} --rm -i --restart=Never `
      + `--image=curlimages/curl:8.10.1 --quiet --command -- `
      + `curl -fsS --max-time 5 ${url}`;
    const result = await opts.runner.exec(cmd);
    if (result.exitCode === 0) return true;
    opts.log(`health probe non-zero (${result.exitCode}); retrying`);
    await new Promise((r) => setTimeout(r, HEALTH_RETRY_INTERVAL_MS));
  }
  return false;
}

async function randomLocalPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close((err) => (err ? reject(err) : resolve(p)));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
  });
}
