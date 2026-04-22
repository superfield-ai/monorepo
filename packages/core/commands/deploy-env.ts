import { renderMigrateJobManifest } from "../templates/k8s/render-migrate-job.ts";
import {
  renderCleanRoomPvcManifest,
  renderSeedJobManifest,
} from "../templates/k8s/render-seed-job.ts";
import { renderPostgresManifest } from "../templates/k8s/render.ts";
import { SshClient } from "../ssh/client.ts";
import { getAuthToken } from "../github/auth.ts";

/**
 * Result of a single command executed by a {@link KubeRunner}.
 */
export interface KubeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * KubeRunner is the seam between {@link deployEnv} and the underlying execution
 * environment. The production implementation runs `kubectl` over SSH against
 * the target VM (see {@link SshKubeRunner}). Tests inject an in-memory
 * recorder. This is NOT a mock — it is a real interface used in production.
 */
export interface KubeRunner {
  /**
   * Execute a single shell command. `stdin`, when provided, is piped to the
   * command's standard input. The runner MUST resolve (not reject) on
   * non-zero exit codes; only spawn / transport errors should reject.
   */
  exec(command: string, opts?: { stdin?: string }): Promise<KubeRunResult>;
}

/**
 * Default {@link KubeRunner} backed by an established {@link SshClient}.
 * Heredoc-pipes stdin into the remote command when supplied.
 */
export class SshKubeRunner implements KubeRunner {
  constructor(private readonly ssh: SshClient) {}

  async exec(command: string, opts?: { stdin?: string }): Promise<KubeRunResult> {
    if (opts?.stdin === undefined) {
      return this.ssh.exec(command);
    }
    // Heredoc avoids quoting issues when piping multi-line manifests.
    // SF_STDIN_EOF is unlikely to appear in a Kubernetes manifest.
    const wrapped =
      `cat <<'SF_STDIN_EOF' | ${command}\n${opts.stdin}\nSF_STDIN_EOF`;
    return this.ssh.exec(wrapped);
  }
}

export interface DeployEnvOptions {
  /** owner/name */
  repo: string;
  env: string;
  /** semver or sha- tag (also accepts already-resolved digests for tests) */
  tag: string;
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
  /** default `ghcr.io/<repo lowercase>` */
  imageRepo?: string;
  onLog?: (line: string) => void;
  dryRun?: boolean;
  /**
   * If true, before the normal deploy flow runs:
   *   - reject when {@link DeployEnvOptions.dbMode} !== "local"
   *   - provision a fresh PVC named `postgres-data-<env>-<YYYYMMDDHHMMSS>`
   *   - re-create the postgres StatefulSet pointing at the new PVC (the
   *     `--cascade=orphan` delete + re-apply dance is required because
   *     `volumeClaimTemplates` is immutable in standard k8s)
   *   - wait for the new postgres pod to become Ready
   *   - run a one-shot seed Job (`/app seed`) and wait for Complete
   *   - print the prior PVC name and a `kubectl delete pvc` hint at the end
   */
  cleanRoom?: boolean;
  /**
   * Required when {@link DeployEnvOptions.cleanRoom} is true.
   * Clean-room is rejected for `managed` (RDS/CloudSQL/etc) databases.
   */
  dbMode?: "local" | "managed";
  /** Test seam for clean-room timestamp generation. Default: `() => new Date()`. */
  now?: () => Date;
  deps?: {
    ghcrFetch?: typeof fetch;
    githubFetch?: typeof fetch;
    githubToken?: string;
    /**
     * Override the kubectl execution path. Default constructs an
     * {@link SshKubeRunner} from the SSH options.
     */
    runner?: KubeRunner;
    /** Override the SSH tunnel path. Default uses the real SshClient. */
    openTunnel?: () => Promise<{ close: () => Promise<void> }>;
    /** Override the host-key trust step. Default uses the real SshClient. */
    trustHostKey?: () => Promise<void>;
  };
}

export interface DeployEnvResult {
  digest: string;
  rolledOut: string[];
  healthy: true;
  /**
   * Set when clean-room ran successfully. The new PVC is in use; the
   * `preservedPvcs` were not deleted and remain bound to the (now
   * orphaned) data on disk.
   */
  cleanRoom?: {
    newPvc: string;
    preservedPvcs: string[];
  };
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

/**
 * Resolve a container tag to a content-addressed digest by issuing a HEAD
 * request to the GHCR v2 manifests endpoint. Reads `Docker-Content-Digest`
 * from the response headers.
 *
 * GHCR requires a Bearer token even for public images. We first try the
 * caller-supplied token; if GHCR responds 401 with a `WWW-Authenticate`
 * pointing at a token server, we exchange the user token for a registry
 * token and retry once.
 */
export async function resolveTagToDigest(opts: {
  repo: string;
  tag: string;
  ghcrFetch?: typeof fetch;
  githubToken: string;
}): Promise<string> {
  const fetchImpl = opts.ghcrFetch ?? globalThis.fetch;
  const image = opts.repo.toLowerCase();
  const url = `https://ghcr.io/v2/${image}/manifests/${opts.tag}`;

  const acceptHeader = [
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
  ].join(",");

  // GHCR accepts the user token as a Basic auth password (username can be
  // anything) for public repos; for private repos we follow the
  // WWW-Authenticate token-server flow. We try the token-server flow first
  // because it works for both.
  let bearerToken: string | undefined;

  // First attempt: anonymous, expecting a 401 with a token-server hint.
  const probe = await fetchImpl(url, {
    method: "HEAD",
    headers: { Accept: acceptHeader },
  });
  if (probe.status === 200) {
    const digest = probe.headers.get("docker-content-digest");
    if (!digest) {
      throw new Error(
        `GHCR returned 200 for ${image}:${opts.tag} but no Docker-Content-Digest header`,
      );
    }
    return digest;
  }
  if (probe.status === 401) {
    const challenge = probe.headers.get("www-authenticate") ?? "";
    const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
    const service = /service="([^"]+)"/.exec(challenge)?.[1];
    const scope = /scope="([^"]+)"/.exec(challenge)?.[1]
      ?? `repository:${image}:pull`;
    if (!realm) {
      throw new Error(
        `GHCR 401 missing realm in WWW-Authenticate: ${challenge || "(empty)"}`,
      );
    }
    const tokenUrl = new URL(realm);
    if (service) tokenUrl.searchParams.set("service", service);
    tokenUrl.searchParams.set("scope", scope);
    const tokenRes = await fetchImpl(tokenUrl.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.githubToken}`,
      },
    });
    if (!tokenRes.ok) {
      throw new Error(
        `GHCR token exchange failed (${tokenRes.status}) at ${tokenUrl.toString()}`,
      );
    }
    const tokenJson = (await tokenRes.json()) as { token?: string; access_token?: string };
    bearerToken = tokenJson.token ?? tokenJson.access_token;
    if (!bearerToken) {
      throw new Error(`GHCR token exchange returned no token`);
    }
  } else if (probe.status === 404) {
    throw new Error(
      `GHCR tag not found: ${image}:${opts.tag} — verify the image and tag exist`,
    );
  } else {
    throw new Error(
      `GHCR HEAD ${url} failed with status ${probe.status}`,
    );
  }

  const authed = await fetchImpl(url, {
    method: "HEAD",
    headers: {
      Accept: acceptHeader,
      Authorization: `Bearer ${bearerToken}`,
    },
  });
  if (authed.status === 404) {
    throw new Error(
      `GHCR tag not found: ${image}:${opts.tag} — verify the image and tag exist`,
    );
  }
  if (!authed.ok) {
    throw new Error(
      `GHCR HEAD ${url} failed with status ${authed.status} after auth`,
    );
  }
  const digest = authed.headers.get("docker-content-digest");
  if (!digest) {
    throw new Error(
      `GHCR returned ${authed.status} for ${image}:${opts.tag} but no Docker-Content-Digest header`,
    );
  }
  return digest;
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
      description: "superfield deploy-env",
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
  const url = `https://api.github.com/repos/${opts.repo}/deployments/${opts.deploymentId}/statuses`;
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

/**
 * Drive a rolling update of the application + workers on a provisioned VM.
 *
 * High-level flow:
 *   1. Resolve `tag → digest` via GHCR
 *   2. Open SSH (trust host key first contact); open k8s API tunnel
 *   3. Run migration Job; wait for Complete (abort on Failed — app NOT touched)
 *   4. `kubectl set image` on the app deployment; wait `rollout status`
 *   5. Same for each worker, sequentially
 *   6. Health gate via in-cluster curl through `kubectl run --rm`
 *   7. On any failure of 4/5/6: `rollout undo` for every deployment touched
 *   8. Annotate the GitHub deployment with digest + outcome
 */
export async function deployEnv(
  opts: DeployEnvOptions,
): Promise<DeployEnvResult> {
  const log = makeLog(opts.onLog);
  const env = opts.env;
  const appNamespace = opts.appNamespace ?? "default";
  const healthPath = opts.healthPath ?? "/healthz";
  const sshUser = opts.sshUser ?? "root";
  const workerNames = opts.workerNames ?? [];
  const imageRepo = opts.imageRepo ?? `ghcr.io/${opts.repo.toLowerCase()}`;

  log(`deploy-env starting: repo=${opts.repo} env=${env} tag=${opts.tag}`);

  // ── Clean-room precondition ─────────────────────────────────────────────
  // Reject before any network or kubectl side-effect when --clean-room is
  // requested against a managed (RDS/CloudSQL/etc.) database. Operators must
  // reset managed DBs out of band; clean-room is strictly for the local
  // postgres-StatefulSet + PVC topology.
  if (opts.cleanRoom && opts.dbMode !== "local") {
    throw new Error(
      `deploy-env: --clean-room is only supported when dbMode=local `
      + `(got dbMode=${opts.dbMode ?? "<unset>"} for env=${env}). `
      + `Reset managed databases out of band.`,
    );
  }

  // ── Step 1: resolve tag → digest ────────────────────────────────────────
  const githubToken =
    opts.deps?.githubToken
    ?? (await getAuthToken().catch(() => ""));
  if (!githubToken) {
    throw new Error(
      "deploy-env: no GitHub token available (set GITHUB_TOKEN or run `gh auth login`)",
    );
  }
  const digest = await resolveTagToDigest({
    repo: opts.repo,
    tag: opts.tag,
    ghcrFetch: opts.deps?.ghcrFetch ?? undefined,
    githubToken,
  });
  log(`resolved ${opts.tag} → ${digest}`);

  // ── Dry-run short-circuit ───────────────────────────────────────────────
  if (opts.dryRun) {
    log(`[dry-run] would render+apply migrate Job for env=${env} tag=${digest}`);
    log(`[dry-run] would set image deployment/${opts.appName} → ${imageRepo}@${digest}`);
    for (const w of workerNames) {
      log(`[dry-run] would set image deployment/${w} → ${imageRepo}@${digest}`);
    }
    log(`[dry-run] would health-check ${opts.appName}.${appNamespace}${healthPath}`);
    return { digest, rolledOut: [opts.appName, ...workerNames], healthy: true };
  }

  // ── Step 2: open SSH + tunnel ───────────────────────────────────────────
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

  // The k8s API tunnel is established to surface a real failure here even
  // when callers inject a synthetic runner. Tests inject `openTunnel` to
  // skip the network step.
  const tunnel = opts.deps?.openTunnel
    ? await opts.deps.openTunnel()
    : await ssh.tunnel(6443, await randomLocalPort());
  log(`opened k8s API tunnel to ${opts.host}:6443`);

  const runner: KubeRunner = opts.deps?.runner ?? new SshKubeRunner(ssh);
  const touched: string[] = [];

  // Annotate via GitHub deployment record (best effort).
  const githubFetch = opts.deps?.githubFetch ?? globalThis.fetch;
  let deployment: DeploymentRecord | null = null;
  try {
    deployment = await createGithubDeployment({
      repo: opts.repo,
      env,
      ref: opts.tag,
      fetchImpl: githubFetch,
      token: githubToken,
    });
    if (deployment) log(`created GitHub deployment ${deployment.id}`);
  } catch (err) {
    log(`warning: failed to create GitHub deployment record: ${(err as Error).message}`);
  }

  const annotateOutcome = async (
    state: "success" | "failure",
    description: string,
  ): Promise<void> => {
    if (!deployment) {
      log(`outcome=${state} digest=${digest} (no deployment record to annotate)`);
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
      log(`warning: failed to update deployment status: ${(err as Error).message}`);
    }
  };

  // Clean-room state captured for the result + end-of-run hint.
  let cleanRoomState: { newPvc: string; preservedPvcs: string[] } | null = null;

  try {
    // ── Step 2.5: clean-room preparation (optional) ──────────────────────
    // The flow:
    //   a. render + apply a fresh PVC named with a YYYYMMDDHHMMSS suffix
    //   b. delete the existing postgres StatefulSet with --cascade=orphan
    //      (Kubernetes forbids mutating volumeClaimTemplates in place;
    //      deleting with orphan retains the existing pod momentarily, then
    //      the re-applied StatefulSet adopts a fresh template pointing at
    //      the new PVC and the pod is recreated bound to the new volume)
    //   c. apply the postgres manifest with the new volumeClaimTemplate
    //      name + matching pod volumes reference
    //   d. wait for the new postgres pod to be Ready
    //   e. render + apply the seed Job; abort on failure
    //   The previous PVC is intentionally left in place; operators reclaim
    //   it explicitly with `kubectl delete pvc <name>` once they no longer
    //   want the prior dataset.
    if (opts.cleanRoom) {
      const nowFn = opts.now ?? (() => new Date());
      const timestamp = formatTimestamp(nowFn());
      const newPvcName = `postgres-data-${env}-${timestamp}`;
      // Old PVCs the operator may want to delete after verification.
      // We always include the unsuffixed name (the very first deploy
      // creates it) and leave any prior timestamp-suffixed names to be
      // surfaced by `kubectl get pvc` — we cannot enumerate them here
      // without an extra round-trip and the operator-facing hint is the
      // same either way.
      const preservedPvcs = [`postgres-data-${env}`];
      cleanRoomState = { newPvc: newPvcName, preservedPvcs };

      log(`clean-room: provisioning fresh PVC ${newPvcName}`);
      const pvcManifest = renderCleanRoomPvcManifest({
        env,
        pvcName: newPvcName,
      });
      const pvcApply = await runner.exec(
        `kubectl apply -n ${appNamespace} -f -`,
        { stdin: pvcManifest },
      );
      if (pvcApply.exitCode !== 0) {
        throw new DeployStepError(
          "clean-room-pvc-apply",
          `kubectl apply (PVC) failed (exit ${pvcApply.exitCode}): `
          + (pvcApply.stderr.trim() || pvcApply.stdout.trim()),
        );
      }

      log(
        `clean-room: deleting StatefulSet postgres-${env} `
        + `with --cascade=orphan (volumeClaimTemplates is immutable)`,
      );
      const stsDelete = await runner.exec(
        `kubectl delete sts -n ${appNamespace} postgres-${env} `
        + `--cascade=orphan --ignore-not-found`,
      );
      if (stsDelete.exitCode !== 0) {
        throw new DeployStepError(
          "clean-room-sts-delete",
          `kubectl delete sts failed (exit ${stsDelete.exitCode}): `
          + (stsDelete.stderr.trim() || stsDelete.stdout.trim()),
        );
      }

      log(`clean-room: re-applying postgres manifest pointing at ${newPvcName}`);
      const postgresManifest = rewritePostgresManifestPvcName(
        renderPostgresManifest(env),
        env,
        newPvcName,
      );
      const stsApply = await runner.exec(
        `kubectl apply -n ${appNamespace} -f -`,
        { stdin: postgresManifest },
      );
      if (stsApply.exitCode !== 0) {
        throw new DeployStepError(
          "clean-room-sts-apply",
          `kubectl apply (StatefulSet) failed (exit ${stsApply.exitCode}): `
          + (stsApply.stderr.trim() || stsApply.stdout.trim()),
        );
      }

      log(`clean-room: waiting for postgres-${env} pod to be Ready`);
      const pgWait = await runner.exec(
        `kubectl wait -n ${appNamespace} `
        + `--for=condition=Ready --timeout=${ROLLOUT_TIMEOUT} `
        + `pod -l app=postgres,env=${env}`,
      );
      if (pgWait.exitCode !== 0) {
        throw new DeployStepError(
          "clean-room-pg-ready",
          `postgres pod did not reach Ready: `
          + (pgWait.stderr.trim() || pgWait.stdout.trim()),
        );
      }

      log(`clean-room: applying db-seed Job`);
      const seedManifest = renderSeedJobManifest({
        env,
        tag: digest,
        imageRepo,
      });
      const seedJobName = extractJobName(seedManifest);
      const seedApply = await runner.exec(
        `kubectl apply -n ${appNamespace} -f -`,
        { stdin: seedManifest },
      );
      if (seedApply.exitCode !== 0) {
        throw new DeployStepError(
          "clean-room-seed-apply",
          `kubectl apply (seed Job) failed (exit ${seedApply.exitCode}): `
          + (seedApply.stderr.trim() || seedApply.stdout.trim()),
        );
      }
      log(`clean-room: waiting for seed Job ${seedJobName} to complete`);
      const seedWait = await runner.exec(
        `kubectl wait -n ${appNamespace} `
        + `--for=condition=Complete --timeout=${ROLLOUT_TIMEOUT} `
        + `job/${seedJobName}`,
      );
      if (seedWait.exitCode !== 0) {
        throw new DeployStepError(
          "clean-room-seed-wait",
          `seed Job did not complete: `
          + (seedWait.stderr.trim() || seedWait.stdout.trim()),
        );
      }
      log(`clean-room: seed Job complete`);
    }

    // ── Step 3: migration ────────────────────────────────────────────────
    const manifest = renderMigrateJobManifest({
      env,
      tag: digest,
      imageRepo,
    });
    const jobName = extractJobName(manifest);
    log(`applying migrate Job ${jobName}`);
    const apply = await runner.exec(`kubectl apply -n ${appNamespace} -f -`, {
      stdin: manifest,
    });
    if (apply.exitCode !== 0) {
      throw new DeployStepError(
        "migrate-apply",
        `kubectl apply failed (exit ${apply.exitCode}): ${apply.stderr.trim() || apply.stdout.trim()}`,
      );
    }

    log(`waiting for migrate Job ${jobName} to complete`);
    const wait = await runner.exec(
      `kubectl wait -n ${appNamespace} --for=condition=Complete --timeout=${ROLLOUT_TIMEOUT} job/${jobName}`,
    );
    if (wait.exitCode !== 0) {
      // Surface Failed-vs-timeout in the message; either way the app
      // deployment is NOT touched.
      throw new DeployStepError(
        "migrate-wait",
        `migrate Job did not complete: ${wait.stderr.trim() || wait.stdout.trim()}`,
      );
    }
    log(`migrate Job complete`);

    // ── Step 4 + 5: app rollout, then workers sequentially ───────────────
    for (const name of [opts.appName, ...workerNames]) {
      log(`setting image on deployment/${name} → ${imageRepo}@${digest}`);
      const setImage = await runner.exec(
        `kubectl set image -n ${appNamespace} deployment/${name} ${name}=${imageRepo}@${digest}`,
      );
      if (setImage.exitCode !== 0) {
        throw new DeployStepError(
          name === opts.appName ? "app-set-image" : `worker-set-image:${name}`,
          `kubectl set image failed for ${name}: ${setImage.stderr.trim() || setImage.stdout.trim()}`,
          touched,
        );
      }
      touched.push(name);

      log(`waiting for rollout of deployment/${name}`);
      const status = await runner.exec(
        `kubectl rollout status -n ${appNamespace} deployment/${name} --timeout=${ROLLOUT_TIMEOUT}`,
      );
      if (status.exitCode !== 0) {
        throw new DeployStepError(
          name === opts.appName ? "app-rollout" : `worker-rollout:${name}`,
          `rollout status failed for ${name}: ${status.stderr.trim() || status.stdout.trim()}`,
          touched,
        );
      }
    }

    // ── Step 6: health gate ──────────────────────────────────────────────
    log(`health-checking http://${opts.appName}.${appNamespace}.svc.cluster.local${healthPath}`);
    const healthy = await healthGate({
      runner,
      appName: opts.appName,
      namespace: appNamespace,
      healthPath,
      log,
    });
    if (!healthy) {
      throw new DeployStepError(
        "health-gate",
        `health check did not return 200 within ${HEALTH_TIMEOUT_MS / 1000}s`,
        touched,
      );
    }
    log(`health check passed`);

    await annotateOutcome("success", `deployed ${digest}`);
    if (cleanRoomState) {
      log(
        `clean-room: previous PVC name(s) preserved: `
        + cleanRoomState.preservedPvcs.join(", "),
      );
      log(
        `clean-room: to reclaim, run `
        + `kubectl delete pvc -n ${appNamespace} `
        + cleanRoomState.preservedPvcs.join(" "),
      );
    }
    log(`deploy-env complete: digest=${digest}`);
    return {
      digest,
      rolledOut: [opts.appName, ...workerNames],
      healthy: true,
      ...(cleanRoomState ? { cleanRoom: cleanRoomState } : {}),
    };
  } catch (err) {
    const stepErr = err instanceof DeployStepError ? err : null;
    const failingStep = stepErr?.step ?? "unknown";
    const message = (err as Error).message;
    log(`deploy-env failed at step=${failingStep}: ${message}`);

    // Roll back every deployment we touched in this run.
    const rollbackTargets = stepErr?.touched ?? touched;
    for (const name of rollbackTargets) {
      log(`rolling back deployment/${name}`);
      try {
        const undo = await runner.exec(
          `kubectl rollout undo -n ${appNamespace} deployment/${name}`,
        );
        if (undo.exitCode !== 0) {
          log(`warning: rollout undo for ${name} returned exit ${undo.exitCode}: ${undo.stderr.trim()}`);
        }
      } catch (undoErr) {
        log(`warning: rollout undo for ${name} threw: ${(undoErr as Error).message}`);
      }
    }

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

class DeployStepError extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly touched: string[] = [],
  ) {
    super(`[${step}] ${message}`);
    this.name = "DeployStepError";
  }
}

function extractJobName(manifest: string): string {
  // Cheap, deterministic: the renderer emits `name: db-migrate-<env>-<tag>`
  // as a top-level field of `metadata`. We don't need a full YAML parse.
  const match = /\n\s{2}name:\s*([^\n]+)/.exec(manifest);
  if (!match || !match[1]) {
    throw new Error("rendered migrate manifest missing metadata.name");
  }
  return match[1].trim();
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

/**
 * Format a Date as YYYYMMDDHHMMSS in UTC. Used for clean-room PVC naming so
 * the suffix sorts lexicographically by creation order.
 */
function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    `${d.getUTCFullYear()}`
    + `${pad(d.getUTCMonth() + 1)}`
    + `${pad(d.getUTCDate())}`
    + `${pad(d.getUTCHours())}`
    + `${pad(d.getUTCMinutes())}`
    + `${pad(d.getUTCSeconds())}`
  );
}

/**
 * Rewrite the postgres StatefulSet manifest to point at a new PVC name.
 *
 * The vendored template names its volumeClaimTemplate `postgres-data-<env>`
 * and the pod's `volumeMounts[0].name` references the same. To swap PVCs we
 * substitute every literal occurrence of the old name with the new one. The
 * Service document in the same manifest is unaffected because it only
 * references the StatefulSet name.
 *
 * Replacement is a literal string swap rather than a YAML rewrite because
 * the renderer's output is a deterministic stringification — the only place
 * `postgres-data-<env>` appears as a value is in the volume references.
 */
function rewritePostgresManifestPvcName(
  manifest: string,
  env: string,
  newName: string,
): string {
  const oldName = `postgres-data-${env}`;
  // Replace exact occurrences only (avoid clobbering label values that
  // happen to share a prefix). The renderer emits `name: postgres-data-<env>`
  // with no quoting; values are written one per line.
  // Negative lookahead `(?!-)` keeps us from re-rewriting an already
  // suffixed name (e.g. `postgres-data-demo-20260418123456`).
  const pattern = new RegExp(`\\b${oldName}(?!-)\\b`, "g");
  return manifest.replace(pattern, newName);
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
