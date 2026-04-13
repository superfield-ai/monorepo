export const DEPLOY_PHASES = ["provision", "deploy"] as const;

export type DeployPhase = (typeof DEPLOY_PHASES)[number];

export interface DeployPhaseModel {
  name: DeployPhase;
  title: string;
  description: string;
  implemented: false;
}

export interface DeployTargetModel {
  name: string;
  description: string;
  phases: DeployPhaseModel[];
}

export interface DeployCommandOpts {
  phase: DeployPhase;
  target?: string;
  cwd?: string;
}

export class DeployTargetNotImplementedError extends Error {
  constructor(
    readonly target: string,
  ) {
    super(`Deploy target "${target}" is not implemented yet.`);
    this.name = "DeployTargetNotImplementedError";
  }
}

export class DeployPhaseNotImplementedError extends Error {
  constructor(
    readonly target: string,
    readonly phase: DeployPhase,
  ) {
    super(`Deploy phase "${phase}" for target "${target}" is not implemented yet.`);
    this.name = "DeployPhaseNotImplementedError";
  }
}

export const DEMO_DEPLOY_TARGET: DeployTargetModel = {
  name: "demo",
  description: "Local demo environment placeholder.",
  phases: [
    {
      name: "provision",
      title: "Provision demo environment",
      description: "Placeholder seam for demo provisioning work.",
      implemented: false,
    },
    {
      name: "deploy",
      title: "Deploy to demo environment",
      description: "Placeholder seam for demo deployment work.",
      implemented: false,
    },
  ],
};

export function parseDeployPhase(
  phase: string | undefined,
): DeployPhase | null {
  if (phase === "provision" || phase === "deploy") return phase;
  return null;
}

export function getDeployTargetModel(
  target: string | undefined = "demo",
): DeployTargetModel {
  if (target === "demo" || target === undefined) return DEMO_DEPLOY_TARGET;
  throw new DeployTargetNotImplementedError(target);
}

export async function runDeployCommand(
  opts: DeployCommandOpts,
): Promise<never> {
  const target = getDeployTargetModel(opts.target);
  throw new DeployPhaseNotImplementedError(target.name, opts.phase);
}
