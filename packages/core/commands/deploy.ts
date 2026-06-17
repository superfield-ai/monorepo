import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { translateKubernetesManifest } from "@superfield/control-core";
import {
  makeDefaultAuthDeps,
  makeDefaultHttpDeps,
  runDoctor,
  runProvision,
  runGcpDeploy,
  googleJsonRequest,
  getGoogleCredentialInfo,
  getGoogleAccessToken,
} from "../gcp/index.js";
import type { ProvisionConfig } from "../gcp/index.js";
import type { GcpDeployConfig, GcpDeployDeps } from "../gcp/index.js";
import {
  ConfigError,
  InternalError,
  ProviderError,
  UserInputError,
} from "../errors.ts";

/**
 * Known deploy phases: provision infrastructure, then deploy workloads.
 *
 * Scout finding (#388): current deployment targets are k3d local and GCP
 * Cloud Run. Runtime signal sources (pod logs, k8s events, CI deploy status,
 * health probes) have no episode-ingestion path yet. Issues #380-#382 will
 * build the deploy/rollback and signal-capture layer.
 *
 * @see docs/architecture.md §CLI — Command Surface
 */
export const DEPLOY_PHASES = ["provision", "deploy"] as const;

export type DeployPhase = (typeof DEPLOY_PHASES)[number];

/**
 * Stub: runtime-signal source descriptor — placeholder for issue #381.
 *
 * @see docs/architecture.md §CLI — Command Surface
 */
export interface RuntimeSignalSource {
  name: string;
  description: string;
  implemented: false;
}

export interface DeployPhaseModel {
  name: DeployPhase;
  title: string;
  description: string;
  implemented: boolean;
}

export interface DeployTargetModel {
  name: string;
  description: string;
  phases: DeployPhaseModel[];
}

/**
 * Deployment backend. `k3s` is the existing k3d/kubectl/docker path. `fastenv`
 * runs the deployment tier on the fastenv container engine — translating the
 * k8s manifests into a FastenvManifest and driving `fastenv up` with no
 * kubectl, Docker daemon, or k3d. Selecting `fastenv` is what unblocks #660
 * criterion 4 (deploy Superfield with no kubectl/docker in the command trace).
 */
export type DeployBackend = "k3s" | "fastenv";

export const DEFAULT_DEPLOY_BACKEND: DeployBackend = "k3s";

export interface DeployCommandOpts {
  target?: string;
  provisionOnly?: boolean;
  demoRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Which deployment backend to drive. Defaults to "k3s". */
  backend?: DeployBackend;
}

export interface DeployProcessStep {
  phase: DeployPhase;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  installHint?: string;
}

export type DeployProcessRunner = (step: DeployProcessStep) => Promise<void>;

export interface DeployCommandDeps {
  runProcess?: DeployProcessRunner;
  probeIngress?: (url: string) => Promise<void>;
  fileExists?: (filePath: string) => boolean;
  copyFile?: (source: string, destination: string) => void;
  readFile?: (filePath: string) => string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  promptDeleteDataDir?: (dataPath: string) => Promise<boolean>;
  deleteDataDir?: (dataPath: string) => void;
  /** List the files in a directory (used by the fastenv backend). */
  readDir?: (dirPath: string) => string[];
  /** Persist the translated FastenvManifest before `fastenv up` reads it. */
  writeManifest?: (manifestPath: string, contents: string) => void;
}

export class DeployTargetNotImplementedError extends UserInputError {
  constructor(readonly target: string) {
    super(`Deploy target "${target}" is not implemented yet.`, {
      context: { target },
    });
  }
}

export class DeployPhaseNotImplementedError extends InternalError {
  constructor(
    readonly target: string,
    readonly phase: DeployPhase,
  ) {
    super(
      `Deploy phase "${phase}" for target "${target}" is not implemented yet.`,
      { context: { target, phase } },
    );
  }
}

export class DeployPhaseExecutionError extends ProviderError {
  constructor(
    readonly target: string,
    readonly phase: DeployPhase,
    readonly step: string,
    cause: unknown,
  ) {
    super(
      target,
      `${phaseTitle(phase)} failed for target "${target}" during ${step}: ${formatError(cause)}`,
      { cause, context: { target, phase, step } },
    );
  }
}

export class MissingDependencyError extends ConfigError {
  constructor(
    readonly command: string,
    readonly installHint?: string,
  ) {
    const hint = installHint ? `\n  Install it with: ${installHint}` : "";
    super(`"${command}" not found on PATH.${hint}`, {
      context: { command, installHint },
    });
  }
}

export const DEMO_DEPLOY_TARGET: DeployTargetModel = {
  name: "demo",
  description:
    "Local Superfield demo environment rooted at ~/superfield-distribution.",
  phases: [
    {
      name: "provision",
      title: "Provision demo environment",
      description:
        "Validate prerequisites and ensure the local k3d demo cluster exists.",
      implemented: true,
    },
    {
      name: "deploy",
      title: "Deploy to demo environment",
      description:
        "Build the demo images, apply manifests, and wait for the demo URL.",
      implemented: true,
    },
  ],
};

const DEMO_REGISTRY = "localhost:5000";
const DEMO_TAG = "dev";
export const DEFAULT_DEMO_PORT = 58080;
const WAIT_TIMEOUT = "120s";

interface DemoContext {
  target: DeployTargetModel;
  demoRoot: string;
  env: NodeJS.ProcessEnv;
  runProcess: DeployProcessRunner;
  probeIngress: (url: string) => Promise<void>;
  fileExists: (filePath: string) => boolean;
  copyFile: (source: string, destination: string) => void;
  readFile: (filePath: string) => string;
  promptDeleteDataDir: (dataPath: string) => Promise<boolean>;
  deleteDataDir: (dataPath: string) => void;
  backend: DeployBackend;
  readDir: (dirPath: string) => string[];
  writeManifest: (manifestPath: string, contents: string) => void;
}

export function parseDeployPhase(
  phase: string | undefined,
): DeployPhase | null {
  if (phase === "provision" || phase === "deploy") return phase;
  return null;
}

export function selectDeployPhases(provisionOnly = false): DeployPhase[] {
  return provisionOnly ? ["provision"] : [...DEPLOY_PHASES];
}

export function getDeployTargetModel(
  target: string | undefined = "demo",
): DeployTargetModel {
  if (target === "demo" || target === undefined) return DEMO_DEPLOY_TARGET;
  throw new DeployTargetNotImplementedError(target);
}

export async function runDemoTeardown(
  opts: Pick<DeployCommandOpts, "demoRoot" | "env"> = {},
  deps: Pick<DeployCommandDeps, "runProcess"> = {},
): Promise<void> {
  const env = buildDemoEnv(opts.env);
  const demoRoot =
    opts.demoRoot ?? path.join(homedir(), "superfield-distribution");
  const runProcess = deps.runProcess ?? spawnProcess;
  await runProcess({
    phase: "provision",
    label: "cluster teardown",
    command: "bun",
    args: [
      "--eval",
      'import { destroyCluster } from "./scripts/local-demo.ts"; await destroyCluster();',
    ],
    cwd: demoRoot,
    env,
  });
}

export async function runDeployCommand(
  opts: DeployCommandOpts,
  deps: DeployCommandDeps = {},
): Promise<void> {
  const target = getDeployTargetModel(opts.target);
  const context = buildDemoContext(target, opts, deps);

  for (const phase of selectDeployPhases(opts.provisionOnly)) {
    if (phase === "provision") {
      if (context.backend === "fastenv") {
        await runFastenvProvision(context);
      } else {
        await runDemoProvision(context);
      }
      continue;
    }
    if (phase === "deploy") {
      if (context.backend === "fastenv") {
        await runFastenvDeploy(context);
      } else {
        await runDemoDeploy(context);
      }
      continue;
    }
    throw new DeployPhaseNotImplementedError(target.name, phase);
  }
}

function buildDemoContext(
  target: DeployTargetModel,
  opts: DeployCommandOpts,
  deps: DeployCommandDeps,
): DemoContext {
  const env = buildDemoEnv(opts.env);
  const demoRoot =
    opts.demoRoot ?? path.join(homedir(), "superfield-distribution");
  return {
    target,
    demoRoot,
    env,
    runProcess: deps.runProcess ?? spawnProcess,
    probeIngress:
      deps.probeIngress ??
      ((url) =>
        waitForIngress(
          url,
          deps.fetchImpl ?? globalThis.fetch,
          deps.sleep ?? defaultSleep,
        )),
    fileExists: deps.fileExists ?? existsSync,
    copyFile: deps.copyFile ?? copyFileSync,
    readFile: deps.readFile ?? ((f) => readFileSync(f, "utf8")),
    promptDeleteDataDir: deps.promptDeleteDataDir ?? defaultPromptDeleteDataDir,
    deleteDataDir:
      deps.deleteDataDir ??
      ((p) => rmSync(p, { recursive: true, force: true })),
    backend: opts.backend ?? DEFAULT_DEPLOY_BACKEND,
    readDir: deps.readDir ?? ((d) => readdirSync(d)),
    writeManifest:
      deps.writeManifest ??
      ((manifestPath, contents) => {
        mkdirSync(path.dirname(manifestPath), { recursive: true });
        writeFileSync(manifestPath, contents, "utf8");
      }),
  };
}

function buildDemoEnv(
  overrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    KUBECONFIG:
      overrides?.KUBECONFIG ??
      process.env.KUBECONFIG ??
      path.join(homedir(), ".kube", "config"),
  };
}

async function runDemoProvision(context: DemoContext): Promise<void> {
  await executeStep(context, {
    phase: "provision",
    label: "docker availability",
    command: "docker",
    args: ["--version"],
    cwd: context.demoRoot,
    env: context.env,
    installHint:
      "sudo apt install docker.io  (Debian/Ubuntu) or https://docs.docker.com/engine/install/",
  });
  await executeStep(context, {
    phase: "provision",
    label: "k3d availability",
    command: "k3d",
    args: ["version"],
    cwd: context.demoRoot,
    env: context.env,
    installHint:
      "curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash",
  });
  await executeStep(context, {
    phase: "provision",
    label: "kubectl availability",
    command: "kubectl",
    args: ["version", "--client"],
    cwd: context.demoRoot,
    env: context.env,
    installHint:
      "sudo apt install kubectl  (Debian/Ubuntu) or https://kubernetes.io/docs/tasks/tools/",
  });
  await executeStep(context, {
    phase: "provision",
    label: "docker daemon check",
    command: "docker",
    args: ["info"],
    cwd: context.demoRoot,
    env: context.env,
  });
  await executeStep(context, {
    phase: "provision",
    label: "demo cluster provisioning",
    command: "bun",
    args: [
      "--eval",
      'import { ensureCluster } from "./scripts/local-demo.ts"; await ensureCluster();',
    ],
    cwd: context.demoRoot,
    env: context.env,
  });
}

/**
 * Reads the postgres manifest from deploy/base/postgres.yaml and extracts
 * the hostPath.path value, if one is defined. Returns null if the manifest
 * doesn't exist or declares no hostPath.
 */
export function detectPostgresDataPath(
  demoRoot: string,
  readFile: (filePath: string) => string,
  fileExists: (filePath: string) => boolean,
): string | null {
  const manifestPath = path.join(demoRoot, "deploy", "base", "postgres.yaml");
  if (!fileExists(manifestPath)) return null;
  const content = readFile(manifestPath);
  const match = /hostPath:\s*\n\s+path:\s*(\S+)/.exec(content);
  return match?.[1] ?? null;
}

async function handlePostgresVolume(context: DemoContext): Promise<void> {
  const dataPath = detectPostgresDataPath(
    context.demoRoot,
    context.readFile,
    context.fileExists,
  );
  if (!dataPath) return;
  if (!context.fileExists(dataPath)) return;

  const shouldDelete = await context.promptDeleteDataDir(dataPath);
  if (shouldDelete) {
    context.deleteDataDir(dataPath);
  }
}

async function runDemoDeploy(context: DemoContext): Promise<void> {
  await ensureLocalSecrets(context);
  await handlePostgresVolume(context);
  await executeStep(context, {
    phase: "deploy",
    label: "image build and push",
    command: "bash",
    args: ["scripts/build-images.sh"],
    cwd: context.demoRoot,
    env: {
      ...context.env,
      PUSH: "true",
      REGISTRY: DEMO_REGISTRY,
      TAG: DEMO_TAG,
    },
  });
  await executeStep(context, {
    phase: "deploy",
    label: "manifest apply",
    command: "kubectl",
    args: ["apply", "-f", "deploy/base/", "-f", "deploy/env/local/"],
    cwd: context.demoRoot,
    env: context.env,
  });

  const secretsPath = path.join(
    context.demoRoot,
    "deploy",
    "env",
    "local",
    "secrets.yaml",
  );
  if (context.fileExists(secretsPath)) {
    await executeStep(context, {
      phase: "deploy",
      label: "local secrets apply",
      command: "kubectl",
      args: ["apply", "-f", "deploy/env/local/secrets.yaml"],
      cwd: context.demoRoot,
      env: context.env,
    });
  }

  await waitForPods(context);
  await runPhaseAction(context, "deploy", "ingress probe", () =>
    context.probeIngress(getDemoUrl(context.env)),
  );
}

async function ensureLocalSecrets(context: DemoContext): Promise<void> {
  const localDir = path.join(context.demoRoot, "deploy", "env", "local");
  const secretsPath = path.join(localDir, "secrets.yaml");
  if (context.fileExists(secretsPath)) return;

  const templatePath = path.join(localDir, "secrets.yaml.template");
  await runPhaseAction(context, "deploy", "local secrets bootstrap", () => {
    context.copyFile(templatePath, secretsPath);
  });
}

async function waitForPods(context: DemoContext): Promise<void> {
  await runPostgresWait(context);

  for (const app of ["api-server", "static-web", "worker"]) {
    await executeStep(context, {
      phase: "deploy",
      label: `${app} readiness`,
      command: "kubectl",
      args: [
        "wait",
        "--for=condition=ready",
        "pod",
        "-l",
        `app=${app}`,
        `--timeout=${WAIT_TIMEOUT}`,
      ],
      cwd: context.demoRoot,
      env: context.env,
    });
  }
}

async function runPostgresWait(context: DemoContext): Promise<void> {
  const primaryStep: DeployProcessStep = {
    phase: "deploy",
    label: "postgres readiness",
    command: "kubectl",
    args: [
      "wait",
      "--for=condition=ready",
      "pod",
      "-l",
      "app=postgres",
      `--timeout=${WAIT_TIMEOUT}`,
    ],
    cwd: context.demoRoot,
    env: context.env,
  };
  const fallbackStep: DeployProcessStep = {
    ...primaryStep,
    args: [
      "wait",
      "--for=condition=ready",
      "pod",
      "-l",
      "app=postgres",
      "--timeout=180s",
    ],
  };

  try {
    await context.runProcess(primaryStep);
  } catch {
    await executeStep(context, fallbackStep);
  }
}

// ---------------------------------------------------------------------------
// fastenv backend — runs the deployment tier on the fastenv container engine.
//
// Emits ONLY `fastenv` commands: no docker, k3d, or kubectl. This is the path
// that unblocks #660 criterion 4 (deploy Superfield with no kubectl/docker in
// the recorded command trace).
// ---------------------------------------------------------------------------

const FASTENV_HEALTH_TIMEOUT_SECS = 120;

/** Absolute path to the FastenvManifest the fastenv backend writes + applies. */
export function fastenvManifestPath(demoRoot: string): string {
  return path.join(demoRoot, "deploy", "fastenv", "manifest.json");
}

/**
 * Translate every k8s manifest under deploy/base into a single FastenvManifest.
 * Reads YAML text directly (no kubectl) and concatenates the documents so the
 * control-core translator sees all workloads.
 */
export function buildFastenvManifest(context: DemoContext): string {
  const baseDir = path.join(context.demoRoot, "deploy", "base");
  let files: string[] = [];
  try {
    files = context.readDir(baseDir).filter((f) => f.endsWith(".yaml"));
  } catch {
    files = [];
  }
  files.sort();

  const documents = files
    .map((f) => context.readFile(path.join(baseDir, f)))
    .filter((doc) => doc.trim().length > 0);

  const manifest = translateKubernetesManifest(documents.join("\n---\n"));
  return JSON.stringify(manifest, null, 2);
}

async function runFastenvProvision(context: DemoContext): Promise<void> {
  // The fastenv backend has no cluster to provision: it only needs the host
  // container engine to be healthy. `fastenv doctor` is the readiness check
  // and replaces docker/k3d/kubectl availability checks entirely.
  await executeStep(context, {
    phase: "provision",
    label: "fastenv runtime availability",
    command: "fastenv",
    args: ["doctor"],
    cwd: context.demoRoot,
    env: context.env,
    installHint:
      "build the fastenv binary from crates/fastenv (cargo build -p fastenv)",
  });
}

async function runFastenvDeploy(context: DemoContext): Promise<void> {
  await ensureLocalSecrets(context);
  await handlePostgresVolume(context);

  // Translate k8s manifests → FastenvManifest and persist it for `fastenv up`.
  const manifestPath = fastenvManifestPath(context.demoRoot);
  await runPhaseAction(
    context,
    "deploy",
    "fastenv manifest translation",
    () => {
      context.writeManifest(manifestPath, buildFastenvManifest(context));
    },
  );

  // Build images on the host (no Docker daemon / registry push).
  await executeStep(context, {
    phase: "deploy",
    label: "image build",
    command: "fastenv",
    args: ["build-base", "deploy/base", "--name", "superfield"],
    cwd: context.demoRoot,
    env: context.env,
  });

  // Bring up the workloads and block until the deployment-tier health gate
  // reports every workload Healthy (init -> deploy-env -> health gate).
  await executeStep(context, {
    phase: "deploy",
    label: "workload up + health gate",
    command: "fastenv",
    args: [
      "up",
      "--manifest",
      manifestPath,
      "--health-gate",
      "--health-timeout-secs",
      String(FASTENV_HEALTH_TIMEOUT_SECS),
    ],
    cwd: context.demoRoot,
    env: context.env,
  });

  await runPhaseAction(context, "deploy", "ingress probe", () =>
    context.probeIngress(getDemoUrl(context.env)),
  );
}

async function executeStep(
  context: DemoContext,
  step: DeployProcessStep,
): Promise<void> {
  await runPhaseAction(context, step.phase, step.label, () =>
    context.runProcess(step),
  );
}

async function runPhaseAction(
  context: DemoContext,
  phase: DeployPhase,
  label: string,
  action: () => Promise<void> | void,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    throw new DeployPhaseExecutionError(
      context.target.name,
      phase,
      label,
      error,
    );
  }
}

async function waitForIngress(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { method: "GET" });
      if (response.ok) return;
    } catch {
      // keep polling until timeout
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function defaultPromptDeleteDataDir(dataPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });

    process.stdout.write(
      `Found existing postgres data at ${dataPath}. Delete it for a clean start? [y/N]: `,
    );
    rl.once("line", (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "y" || trimmed === "yes");
    });
    rl.once("close", () => {
      resolve(false);
    });
  });
}

async function spawnProcess(step: DeployProcessStep): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      stdio: "inherit",
    });

    child.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new MissingDependencyError(step.command, step.installHint));
      } else {
        reject(err);
      }
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Command exited with code ${code}: ${step.command} ${step.args.join(" ")}`,
        ),
      );
    });
  });
}

function getDemoUrl(env: NodeJS.ProcessEnv): string {
  const host = env.SUPERFIELD_DEMO_HOST ?? "localhost";
  const port = Number(env.SUPERFIELD_DEMO_PORT ?? DEFAULT_DEMO_PORT);
  return `http://${host}:${port}/`;
}

function phaseTitle(phase: DeployPhase): string {
  return phase === "provision" ? "Provisioning" : "Deployment";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// GCP deploy command
// ---------------------------------------------------------------------------

export type Logger = (msg: string) => void;

export interface GcpDeployCommandOpts {
  projectId: string;
  region: string;
  zone: string;
  imageTag?: string;
  provisionOnly: boolean;
  logger: Logger;
}

export interface GcpDeployCommandDeps {
  runDoctor?: typeof runDoctor;
  runProvision?: typeof runProvision;
  runGcpDeploy?: typeof runGcpDeploy;
  makeDefaultAuthDeps?: typeof makeDefaultAuthDeps;
  makeDefaultHttpDeps?: typeof makeDefaultHttpDeps;
}

const GCP_PROVISION_DEFAULTS: Omit<
  ProvisionConfig,
  "projectId" | "region" | "zone"
> = {
  networkName: "superfield-vpc",
  subnetName: "superfield-subnet",
  subnetCidr: "10.0.0.0/24",
  podRangeName: "pods",
  podCidr: "10.1.0.0/16",
  serviceRangeName: "services",
  serviceCidr: "10.2.0.0/16",
  sshFirewallName: "superfield-ssh",
  appFirewallName: "superfield-app",
  appPort: "31415",
  psaAddressName: "superfield-psa",
  psaAddressCidr: "10.3.0.0/16",
  alloydbClusterId: "superfield-db",
  alloydbInstanceId: "superfield-db-primary",
  alloydbPassword: process.env["ALLOYDB_PASSWORD"] ?? "changeme",
  vmName: "superfield-vm",
  vmMachineType: "e2-standard-4",
  vmDiskSizeGb: 50,
  vmStartupScript:
    "#!/bin/bash\napt-get update && apt-get install -y docker.io",
};

export async function runGcpDeployCommand(
  opts: GcpDeployCommandOpts,
  deps: GcpDeployCommandDeps = {},
): Promise<void> {
  const log = opts.logger;
  const _runDoctor = deps.runDoctor ?? runDoctor;
  const _runProvision = deps.runProvision ?? runProvision;
  const _runGcpDeploy = deps.runGcpDeploy ?? runGcpDeploy;
  const _makeDefaultAuthDeps = deps.makeDefaultAuthDeps ?? makeDefaultAuthDeps;
  const _makeDefaultHttpDeps = deps.makeDefaultHttpDeps ?? makeDefaultHttpDeps;

  // Step 1: Create auth/http deps
  const authDeps = _makeDefaultAuthDeps();
  const authDepsWithToken = {
    ...authDeps,
    getAccessToken: () => getGoogleAccessToken(authDeps),
  };
  const httpDeps = _makeDefaultHttpDeps(authDepsWithToken);

  // Step 2: Run doctor pre-flight checks
  log("Running GCP pre-flight checks...");
  const doctorResult = await _runDoctor(
    { mode: "provision", projectId: opts.projectId },
    { ...httpDeps, getCredentialInfo: () => getGoogleCredentialInfo(authDeps) },
  );

  if (!doctorResult.ok) {
    const parts: string[] = [
      `GCP pre-flight checks failed for project "${opts.projectId}".`,
    ];
    if (doctorResult.missingPermissions.length > 0) {
      parts.push(
        `Missing permissions: ${doctorResult.missingPermissions.join(", ")}`,
      );
    }
    if (doctorResult.disabledServices.length > 0) {
      parts.push(
        `Disabled services: ${doctorResult.disabledServices.join(", ")}`,
      );
    }
    throw new Error(parts.join("\n"));
  }

  log("Pre-flight checks passed.");

  // Step 3: Build provision config
  const provisionConfig: ProvisionConfig = {
    ...GCP_PROVISION_DEFAULTS,
    projectId: opts.projectId,
    region: opts.region,
    zone: opts.zone,
  };

  // Step 4: Always run provision (idempotent)
  log("Running GCP provisioning...");
  await _runProvision(provisionConfig, { ...httpDeps, log });
  log("GCP provisioning complete.");

  // Step 5: Return early if provision-only
  if (opts.provisionOnly || !opts.imageTag) {
    if (opts.provisionOnly) {
      log("Provision-only mode: skipping deploy.");
    }
    return;
  }

  // Step 6: Run GCP deploy
  log(`Deploying image tag "${opts.imageTag}"...`);

  const deployConfig: GcpDeployConfig = {
    projectId: opts.projectId,
    region: opts.region,
    zone: opts.zone,
    vmName: GCP_PROVISION_DEFAULTS.vmName,
    alloydbClusterId: GCP_PROVISION_DEFAULTS.alloydbClusterId,
    alloydbInstanceId: GCP_PROVISION_DEFAULTS.alloydbInstanceId,
    namespace: "default",
    secretName: "superfield-secrets",
    deploymentName: "superfield",
    imageTag: opts.imageTag,
    deployScript: "deploy.sh",
    sshUser: "root",
  };

  const deployDeps: GcpDeployDeps = {
    googleJsonRequest,
    getAccessToken: httpDeps.getAccessToken,
    fetch: httpDeps.fetch,
    exec: async (cmd, args, execOpts) => {
      const { spawn: _spawn } = await import("node:child_process");
      return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        const child = _spawn(cmd, args, {
          env: execOpts?.env ?? (process.env as Record<string, string>),
          stdio: ["inherit", "pipe", "pipe"],
        });
        child.stdout?.on("data", (d: Buffer) => chunks.push(d));
        child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
        child.on("close", (code) => {
          resolve({
            stdout: Buffer.concat(chunks).toString(),
            stderr: Buffer.concat(errChunks).toString(),
            exitCode: code ?? 1,
          });
        });
      });
    },
    log,
    isGitHubActions: Boolean(process.env["GITHUB_ACTIONS"] === "true"),
  };

  await _runGcpDeploy(deployConfig, deployDeps);
  log("GCP deploy complete.");
}
