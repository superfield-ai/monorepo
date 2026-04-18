import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { deployCommand, parseDeployArgs } from "../../commands/deploy.ts";

const mocks = vi.hoisted(() => ({
  runDeployCommand: vi.fn(),
  runDemoTeardown: vi.fn(),
}));

vi.mock("@superfield/core", () => ({
  runDeployCommand: mocks.runDeployCommand,
  runDemoTeardown: mocks.runDemoTeardown,
  DEFAULT_DEMO_PORT: 58080,
}));

const NO_WAIT_DEPS = {
  fetchPublicIp: async () => null,
  waitForExit: async () => undefined,
};

// process.exit is called after teardown in the full deploy path
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockExit: any;
beforeEach(() => {
  mockExit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.runDeployCommand.mockReset();
  mocks.runDemoTeardown.mockReset();
});

describe("parseDeployArgs", () => {
  it("defaults to a full demo deploy when no args are provided", () => {
    expect(parseDeployArgs([])).toEqual({
      provisionOnly: false,
      target: undefined,
      unknown: [],
    });
  });

  it("parses --provision with an optional target in any order", () => {
    expect(parseDeployArgs(["--provision", "demo"])).toEqual({
      provisionOnly: true,
      target: "demo",
      unknown: [],
    });
    expect(parseDeployArgs(["demo", "--provision"])).toEqual({
      provisionOnly: true,
      target: "demo",
      unknown: [],
    });
  });

  it("captures unknown flags and extra positionals", () => {
    expect(parseDeployArgs(["demo", "staging", "--wat"])).toEqual({
      provisionOnly: false,
      target: "demo",
      unknown: ["staging", "--wat"],
    });
  });
});

describe("deployCommand", () => {
  it("forwards the default full deploy to the core command", async () => {
    mocks.runDeployCommand.mockResolvedValue(undefined);
    mocks.runDemoTeardown.mockResolvedValue(undefined);

    await deployCommand([], NO_WAIT_DEPS);

    expect(mocks.runDeployCommand).toHaveBeenCalledWith({
      provisionOnly: false,
    });
  });

  it("forwards provision-only mode and target to the core command", async () => {
    mocks.runDeployCommand.mockResolvedValue(undefined);

    await deployCommand(["--provision", "demo"]);

    expect(mocks.runDeployCommand).toHaveBeenCalledWith({
      provisionOnly: true,
      target: "demo",
    });
  });

  it("prints usage and exits when deploy args are invalid", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await deployCommand(["demo", "staging"]);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Usage: superfield deploy [--provision] [target]",
      ),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mocks.runDeployCommand).not.toHaveBeenCalled();
  });

  it("prints local and public URLs after a full deploy", async () => {
    mocks.runDeployCommand.mockResolvedValue(undefined);
    mocks.runDemoTeardown.mockResolvedValue(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await deployCommand([], {
      fetchPublicIp: async () => "1.2.3.4",
      waitForExit: async () => undefined,
    });

    const lines = log.mock.calls.flatMap((c) => c);
    expect(lines.some((l) => l.includes("http://localhost:58080/"))).toBe(true);
    expect(lines.some((l) => l.includes("http://1.2.3.4:58080/"))).toBe(true);
  });

  it("skips public URL when public IP is unavailable", async () => {
    mocks.runDeployCommand.mockResolvedValue(undefined);
    mocks.runDemoTeardown.mockResolvedValue(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await deployCommand([], NO_WAIT_DEPS);

    const lines = log.mock.calls.flatMap((c) => c);
    expect(lines.some((l) => l.includes("localhost:58080"))).toBe(true);
    expect(lines.every((l) => !l.includes("public:"))).toBe(true);
  });

  it("tears down the cluster after exit signal", async () => {
    mocks.runDeployCommand.mockResolvedValue(undefined);
    mocks.runDemoTeardown.mockResolvedValue(undefined);

    await deployCommand([], NO_WAIT_DEPS);

    expect(mocks.runDemoTeardown).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("does not tear down on provision-only", async () => {
    mocks.runDeployCommand.mockResolvedValue(undefined);

    await deployCommand(["--provision"]);

    expect(mocks.runDemoTeardown).not.toHaveBeenCalled();
  });
});
