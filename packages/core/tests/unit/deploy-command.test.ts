import { describe, it, expect } from "vitest";
import {
  DEPLOY_PHASES,
  DEMO_DEPLOY_TARGET,
  DeployPhaseNotImplementedError,
  DeployTargetNotImplementedError,
  getDeployTargetModel,
  parseDeployPhase,
  runDeployCommand,
} from "../../commands/deploy.ts";

describe("deploy command seam", () => {
  it("parses the supported deploy phases", () => {
    expect(parseDeployPhase("provision")).toBe("provision");
    expect(parseDeployPhase("deploy")).toBe("deploy");
    expect(parseDeployPhase("demo")).toBeNull();
    expect(DEPLOY_PHASES).toEqual(["provision", "deploy"]);
  });

  it("describes the demo target with placeholder phases", () => {
    expect(getDeployTargetModel("demo")).toEqual(DEMO_DEPLOY_TARGET);
    expect(DEMO_DEPLOY_TARGET.phases.map((phase) => phase.name)).toEqual([
      "provision",
      "deploy",
    ]);
    expect(DEMO_DEPLOY_TARGET.phases.every((phase) => phase.implemented === false)).toBe(
      true,
    );
  });

  it("rejects non-demo targets until #115 implements them", () => {
    expect(() => getDeployTargetModel("staging")).toThrow(
      DeployTargetNotImplementedError,
    );
  });

  it("throws a phase-specific not implemented error for execution", async () => {
    await expect(
      runDeployCommand({ phase: "provision", target: "demo" }),
    ).rejects.toMatchObject({
      name: "DeployPhaseNotImplementedError",
      phase: "provision",
      target: "demo",
    });
  });

  it("surfaces the target in the phase-specific error", async () => {
    await expect(
      runDeployCommand({ phase: "deploy", target: "demo" }),
    ).rejects.toThrow(DeployPhaseNotImplementedError);
  });

  it.todo("plumbs real provision/deploy behavior into the demo target");
  it.todo("adds additional deploy targets without changing the phase model");
});
