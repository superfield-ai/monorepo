import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deployCommand, parseDeployArgs } from "../../commands/deploy.ts";

const mocks = vi.hoisted(() => ({
  runDeployCommand: vi.fn(),
  runDemoTeardown: vi.fn(),
  runGcpDeployCommand: vi.fn(),
  handleLoginLogout: vi.fn(),
  makeDefaultLoginDeps: vi.fn(),
}));

vi.mock("@superfield/core", () => ({
  runDeployCommand: mocks.runDeployCommand,
  runDemoTeardown: mocks.runDemoTeardown,
  runGcpDeployCommand: mocks.runGcpDeployCommand,
  handleLoginLogout: mocks.handleLoginLogout,
  makeDefaultLoginDeps: mocks.makeDefaultLoginDeps,
  DEFAULT_DEMO_PORT: 58080,
}));


let mockExit: any;

beforeEach(() => {
  mockExit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);

  // Default: handleLoginLogout returns false (no login/logout flag handled)
  mocks.handleLoginLogout.mockResolvedValue(false);
  mocks.makeDefaultLoginDeps.mockReturnValue({});
  mocks.runGcpDeployCommand.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.runDeployCommand.mockReset();
  mocks.runGcpDeployCommand.mockReset();
  mocks.handleLoginLogout.mockReset();
  mocks.makeDefaultLoginDeps.mockReset();
});

describe("parseDeployArgs — GCP flags", () => {
  it("parses gcp target with --project", () => {
    const result = parseDeployArgs(["gcp", "--project", "my-proj"]);
    expect(result.target).toBe("gcp");
    expect(result.gcpProject).toBe("my-proj");
    expect(result.unknown).toHaveLength(0);
  });

  it("parses --region and --zone", () => {
    const result = parseDeployArgs([
      "gcp",
      "--project",
      "p",
      "--region",
      "us-east1",
      "--zone",
      "us-east1-b",
    ]);
    expect(result.gcpRegion).toBe("us-east1");
    expect(result.gcpZone).toBe("us-east1-b");
    expect(result.unknown).toHaveLength(0);
  });

  it("parses --image-tag", () => {
    const result = parseDeployArgs([
      "gcp",
      "--project",
      "p",
      "--image-tag",
      "v1.2.3",
    ]);
    expect(result.gcpImageTag).toBe("v1.2.3");
    expect(result.unknown).toHaveLength(0);
  });

  it("parses --provision flag", () => {
    const result = parseDeployArgs(["gcp", "--project", "p", "--provision"]);
    expect(result.provisionOnly).toBe(true);
    expect(result.unknown).toHaveLength(0);
  });

  it("parses --login flag", () => {
    const result = parseDeployArgs([
      "gcp",
      "--login",
      "--client-id",
      "my-client",
    ]);
    expect(result.login).toBe(true);
    expect(result.gcpClientId).toBe("my-client");
    expect(result.unknown).toHaveLength(0);
  });

  it("parses --logout flag", () => {
    const result = parseDeployArgs(["gcp", "--logout"]);
    expect(result.logout).toBe(true);
    expect(result.unknown).toHaveLength(0);
  });

  it("parses --project= equals form", () => {
    const result = parseDeployArgs(["gcp", "--project=my-proj"]);
    expect(result.gcpProject).toBe("my-proj");
    expect(result.unknown).toHaveLength(0);
  });
});

describe("deployCommand — gcp target", () => {
  it("calls runGcpDeployCommand with provisionOnly=true when --provision is passed", async () => {
    await deployCommand(["gcp", "--project", "foo", "--provision"], {
      runGcpDeployCommand: mocks.runGcpDeployCommand,
    });

    expect(mocks.runGcpDeployCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "foo",
        provisionOnly: true,
      }),
    );
    expect(mocks.runDeployCommand).not.toHaveBeenCalled();
  });

  it("calls runGcpDeployCommand with imageTag when --image-tag is passed", async () => {
    await deployCommand(["gcp", "--project", "foo", "--image-tag", "v2.0.0"], {
      runGcpDeployCommand: mocks.runGcpDeployCommand,
    });

    expect(mocks.runGcpDeployCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "foo",
        imageTag: "v2.0.0",
        provisionOnly: false,
      }),
    );
  });

  it("uses default region and zone when not specified", async () => {
    await deployCommand(["gcp", "--project", "foo"], {
      runGcpDeployCommand: mocks.runGcpDeployCommand,
    });

    expect(mocks.runGcpDeployCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "us-central1",
        zone: "us-central1-a",
      }),
    );
  });

  it("errors and exits when --project is missing", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await deployCommand(["gcp", "--provision"], {
      runGcpDeployCommand: mocks.runGcpDeployCommand,
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining("--project"));
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mocks.runGcpDeployCommand).not.toHaveBeenCalled();
  });

  it("handles --login flag via handleLoginLogout", async () => {
    mocks.handleLoginLogout.mockResolvedValue(true);
    mocks.makeDefaultLoginDeps.mockReturnValue({});

    await deployCommand(["gcp", "--login", "--client-id", "my-client"], {
      runGcpDeployCommand: mocks.runGcpDeployCommand,
    });

    expect(mocks.handleLoginLogout).toHaveBeenCalledWith(
      expect.objectContaining({ login: true, clientId: "my-client" }),
      expect.anything(),
    );
  });

  it("handles --logout flag and does not call runGcpDeployCommand", async () => {
    mocks.handleLoginLogout.mockResolvedValue(true);

    await deployCommand(["gcp", "--logout"], {
      runGcpDeployCommand: mocks.runGcpDeployCommand,
    });

    expect(mocks.handleLoginLogout).toHaveBeenCalledWith(
      expect.objectContaining({ logout: true }),
      expect.anything(),
    );
    expect(mocks.runGcpDeployCommand).not.toHaveBeenCalled();
  });
});
