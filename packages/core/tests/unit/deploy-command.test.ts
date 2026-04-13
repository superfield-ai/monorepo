import { describe, it, expect } from "vitest";
import {
  DEPLOY_PHASES,
  DEMO_DEPLOY_TARGET,
  DeployPhaseExecutionError,
  DeployTargetNotImplementedError,
  getDeployTargetModel,
  selectDeployPhases,
  runDeployCommand,
} from "../../commands/deploy.ts";

describe("deploy command", () => {
  it("selects both phases by default and only provisioning with --provision", () => {
    expect(selectDeployPhases()).toEqual(["provision", "deploy"]);
    expect(selectDeployPhases(true)).toEqual(["provision"]);
    expect(DEPLOY_PHASES).toEqual(["provision", "deploy"]);
  });

  it("describes the demo target with implemented phases", () => {
    expect(getDeployTargetModel("demo")).toEqual(DEMO_DEPLOY_TARGET);
    expect(DEMO_DEPLOY_TARGET.phases.map((phase) => phase.name)).toEqual([
      "provision",
      "deploy",
    ]);
    expect(
      DEMO_DEPLOY_TARGET.phases.every((phase) => phase.implemented === true),
    ).toBe(true);
  });

  it("rejects non-demo targets until #115 implements them", () => {
    expect(() => getDeployTargetModel("staging")).toThrow(
      DeployTargetNotImplementedError,
    );
  });

  it("runs only provisioning in --provision mode", async () => {
    const steps: string[] = [];

    await runDeployCommand(
      { provisionOnly: true, demoRoot: "/tmp/calypso" },
      {
        runProcess: async (step) => {
          steps.push(`${step.phase}:${step.command}`);
        },
        probeIngress: async () => {
          throw new Error("probe should not run during provision-only mode");
        },
        fileExists: () => true,
        copyFile: () => undefined,
      },
    );

    expect(steps).toEqual([
      "provision:docker",
      "provision:k3d",
      "provision:kubectl",
      "provision:docker",
      "provision:bun",
    ]);
  });

  it("wraps provisioning failures with a phase-scoped error", async () => {
    await expect(
      runDeployCommand(
        { provisionOnly: true, demoRoot: "/tmp/calypso" },
        {
          runProcess: async (step) => {
            if (step.command === "docker" && step.args[0] === "info") {
              throw new Error("daemon unavailable");
            }
          },
          probeIngress: async () => undefined,
          fileExists: () => true,
          copyFile: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      name: "DeployPhaseExecutionError",
      phase: "provision",
      target: "demo",
    });
  });

  it("wraps deployment failures with a phase-scoped error", async () => {
    await expect(
      runDeployCommand(
        { demoRoot: "/tmp/calypso" },
        {
          runProcess: async (step) => {
            if (step.phase === "deploy" && step.command === "bash") {
              throw new Error("docker build failed");
            }
          },
          probeIngress: async () => undefined,
          fileExists: () => true,
          copyFile: () => undefined,
        },
      ),
    ).rejects.toBeInstanceOf(DeployPhaseExecutionError);
    await expect(
      runDeployCommand(
        { demoRoot: "/tmp/calypso" },
        {
          runProcess: async (step) => {
            if (step.phase === "deploy" && step.command === "bash") {
              throw new Error("docker build failed");
            }
          },
          probeIngress: async () => undefined,
          fileExists: () => true,
          copyFile: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      phase: "deploy",
      target: "demo",
    });
  });
});
