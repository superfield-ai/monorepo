import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export const DEPLOY_PHASES = ["provision", "deploy"] as const;

export type DeployPhase = (typeof DEPLOY_PHASES)[number];

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

export interface DeployCommandOpts {
  target?: string;
  provisionOnly?: boolean;
  demoRoot?: string;
  env?: NodeJS.ProcessEnv;
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
}

export class DeployTargetNotImplementedError extends Error {
  constructor(readonly target: string) {
    super(`Deploy target "${target}" is not implemented yet.`);
    this.name = "DeployTargetNotImplementedError";
  }
}

export class DeployPhaseNotImplementedError extends Error {
  constructor(
    readonly target: string,
    readonly phase: DeployPhase,
  ) {
    super(
      `Deploy phase "${phase}" for target "${target}" is not implemented yet.`,
    );
    this.name = "DeployPhaseNotImplementedError";
  }
}

export class DeployPhaseExecutionError extends Error {
  constructor(
    readonly target: string,
    readonly phase: DeployPhase,
    readonly step: string,
    cause: unknown,
  ) {
    super(
      `${phaseTitle(phase)} failed for target "${target}" during ${step}: ${formatError(cause)}`,
      { cause: cause instanceof Error ? cause : undefined },
    );
    this.name = "DeployPhaseExecutionError";
  }
}

export class MissingDependencyError extends Error {
  constructor(
    readonly command: string,
    readonly installHint?: string,
  ) {
    const hint = installHint ? `\n  Install it with: ${installHint}` : "";
    super(`"${command}" not found on PATH.${hint}`);
    this.name = "MissingDependencyError";
  }
}

export const DEMO_DEPLOY_TARGET: DeployTargetModel = {
  name: "demo",
  description:
    "Local Calypso demo environment rooted at ~/calypso-distribution.",
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
    opts.demoRoot ?? path.join(homedir(), "calypso-distribution");
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
      await runDemoProvision(context);
      continue;
    }
    if (phase === "deploy") {
      await runDemoDeploy(context);
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
    opts.demoRoot ?? path.join(homedir(), "calypso-distribution");
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
    installHint: "sudo apt install docker.io  (Debian/Ubuntu) or https://docs.docker.com/engine/install/",
  });
  await executeStep(context, {
    phase: "provision",
    label: "k3d availability",
    command: "k3d",
    args: ["version"],
    cwd: context.demoRoot,
    env: context.env,
    installHint: "curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash",
  });
  await executeStep(context, {
    phase: "provision",
    label: "kubectl availability",
    command: "kubectl",
    args: ["version", "--client"],
    cwd: context.demoRoot,
    env: context.env,
    installHint: "sudo apt install kubectl  (Debian/Ubuntu) or https://kubernetes.io/docs/tasks/tools/",
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
  const port = Number(env.CALYPSO_DEMO_PORT ?? DEFAULT_DEMO_PORT);
  return `http://localhost:${port}/`;
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
