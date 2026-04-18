import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runGcpDeployCommand,
  type GcpDeployCommandOpts,
} from "../../commands/deploy.ts";
import type { GcpDeployCommandDeps } from "../../commands/deploy.ts";
import type { DoctorResult } from "../../gcp/doctor.ts";

const GOOD_DOCTOR_RESULT: DoctorResult = {
  ok: true,
  projectId: "test-project",
  projectNumber: "123456789",
  missingPermissions: [],
  disabledServices: [],
  warnings: [],
  credential: { source: "GCP_ACCESS_TOKEN", type: "access-token" },
};

const BASE_OPTS: GcpDeployCommandOpts = {
  projectId: "test-project",
  region: "us-central1",
  zone: "us-central1-a",
  provisionOnly: false,
  logger: () => undefined,
};

function makeAuthDeps() {
  return {
    env: (name: string) => process.env[name],
    readFile: () => "",
    writeFile: () => undefined,
    fileExists: () => false,
    fetch: async () => new Response("{}", { status: 200 }),
    now: () => Date.now(),
  };
}

function makeHttpDeps() {
  return {
    fetch: async () => new Response("{}", { status: 200 }),
    getAccessToken: async () => "test-token",
  };
}

function makeDeps(overrides: Partial<GcpDeployCommandDeps> = {}): GcpDeployCommandDeps {
  return {
    runDoctor: vi.fn().mockResolvedValue(GOOD_DOCTOR_RESULT),
    runProvision: vi.fn().mockResolvedValue(undefined),
    runGcpDeploy: vi.fn().mockResolvedValue(undefined),
    makeDefaultAuthDeps: vi.fn().mockReturnValue(makeAuthDeps()),
    makeDefaultHttpDeps: vi.fn().mockReturnValue(makeHttpDeps()),
    ...overrides,
  };
}

describe("runGcpDeployCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("provisionOnly=true calls runProvision and not runGcpDeploy", async () => {
    const deps = makeDeps();

    await runGcpDeployCommand(
      { ...BASE_OPTS, provisionOnly: true },
      deps,
    );

    expect(deps.runProvision).toHaveBeenCalledOnce();
    expect(deps.runGcpDeploy).not.toHaveBeenCalled();
  });

  it("provisionOnly=false with no imageTag calls runProvision only", async () => {
    const deps = makeDeps();

    await runGcpDeployCommand(
      { ...BASE_OPTS, provisionOnly: false, imageTag: undefined },
      deps,
    );

    expect(deps.runProvision).toHaveBeenCalledOnce();
    expect(deps.runGcpDeploy).not.toHaveBeenCalled();
  });

  it("provisionOnly=false with imageTag calls runProvision then runGcpDeploy", async () => {
    const deps = makeDeps();

    await runGcpDeployCommand(
      { ...BASE_OPTS, provisionOnly: false, imageTag: "v1.0.0" },
      deps,
    );

    expect(deps.runProvision).toHaveBeenCalledOnce();
    expect(deps.runGcpDeploy).toHaveBeenCalledOnce();

    // Verify runProvision was called before runGcpDeploy
    const provisionOrder = (deps.runProvision as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const deployOrder = (deps.runGcpDeploy as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(provisionOrder).toBeLessThan(deployOrder);
  });

  it("runGcpDeploy is called with the correct imageTag", async () => {
    const deps = makeDeps();

    await runGcpDeployCommand(
      { ...BASE_OPTS, provisionOnly: false, imageTag: "v2.3.4" },
      deps,
    );

    const deployCallArgs = (deps.runGcpDeploy as ReturnType<typeof vi.fn>).mock.calls[0];
    const deployConfig = deployCallArgs[0] as { imageTag: string };
    expect(deployConfig.imageTag).toBe("v2.3.4");
  });

  it("doctor failure throws listing missing permissions and disabled services", async () => {
    const failingDoctorResult: DoctorResult = {
      ok: false,
      projectId: "test-project",
      projectNumber: "123456789",
      missingPermissions: ["compute.instances.create", "alloydb.clusters.create"],
      disabledServices: ["alloydb.googleapis.com"],
      warnings: [],
      credential: { source: "GCP_ACCESS_TOKEN", type: "access-token" },
    };

    const deps = makeDeps({
      runDoctor: vi.fn().mockResolvedValue(failingDoctorResult),
    });

    await expect(
      runGcpDeployCommand(BASE_OPTS, deps),
    ).rejects.toThrow(/Missing permissions:.*compute.instances.create/);

    expect(deps.runProvision).not.toHaveBeenCalled();
    expect(deps.runGcpDeploy).not.toHaveBeenCalled();
  });

  it("doctor failure message includes disabled services", async () => {
    const failingDoctorResult: DoctorResult = {
      ok: false,
      projectId: "test-project",
      projectNumber: "123456789",
      missingPermissions: [],
      disabledServices: ["compute.googleapis.com", "alloydb.googleapis.com"],
      warnings: [],
      credential: { source: "GCP_ACCESS_TOKEN", type: "access-token" },
    };

    const deps = makeDeps({
      runDoctor: vi.fn().mockResolvedValue(failingDoctorResult),
    });

    await expect(
      runGcpDeployCommand(BASE_OPTS, deps),
    ).rejects.toThrow(/Disabled services:.*compute.googleapis.com/);
  });

  it("runProvision is called with the correct project/region/zone", async () => {
    const deps = makeDeps();

    await runGcpDeployCommand(
      {
        ...BASE_OPTS,
        projectId: "my-project",
        region: "europe-west1",
        zone: "europe-west1-b",
        provisionOnly: true,
      },
      deps,
    );

    const provisionCallArgs = (deps.runProvision as ReturnType<typeof vi.fn>).mock.calls[0];
    const provisionConfig = provisionCallArgs[0] as {
      projectId: string;
      region: string;
      zone: string;
    };
    expect(provisionConfig.projectId).toBe("my-project");
    expect(provisionConfig.region).toBe("europe-west1");
    expect(provisionConfig.zone).toBe("europe-west1-b");
  });
});
