import { describe, it, expect, vi, afterEach } from "vitest";
import { deployCommand, parseDeployArgs } from "../../commands/deploy.ts";

const mocks = vi.hoisted(() => ({
  runDeployCommand: vi.fn(),
}));

vi.mock("@superfield/core", () => ({
  runDeployCommand: mocks.runDeployCommand,
}));

afterEach(() => {
  vi.restoreAllMocks();
  mocks.runDeployCommand.mockReset();
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

    await deployCommand([]);

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
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as never,
    );

    await deployCommand(["demo", "staging"]);

    expect(error).toHaveBeenCalledWith("Usage: superfield deploy [--provision] [target]");
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.runDeployCommand).not.toHaveBeenCalled();
  });
});
