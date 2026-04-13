import { describe, it, expect, vi, afterEach } from "vitest";
import { deployCommand } from "../../commands/deploy.ts";

const mocks = vi.hoisted(() => ({
  parseDeployPhase: vi.fn(),
  runDeployCommand: vi.fn(),
}));

vi.mock("@superfield/core", () => ({
  parseDeployPhase: mocks.parseDeployPhase,
  runDeployCommand: mocks.runDeployCommand,
}));

afterEach(() => {
  vi.restoreAllMocks();
  mocks.parseDeployPhase.mockReset();
  mocks.runDeployCommand.mockReset();
});

describe("deployCommand", () => {
  it("forwards the parsed deploy phase and target to the core command", async () => {
    mocks.parseDeployPhase.mockReturnValue("provision");
    mocks.runDeployCommand.mockResolvedValue(undefined);

    await deployCommand("provision", "demo");

    expect(mocks.parseDeployPhase).toHaveBeenCalledWith("provision");
    expect(mocks.runDeployCommand).toHaveBeenCalledWith({
      phase: "provision",
      target: "demo",
    });
  });

  it("prints usage and exits when the deploy phase is missing", async () => {
    mocks.parseDeployPhase.mockReturnValue(null);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as never,
    );

    await deployCommand(undefined, "demo");

    expect(error).toHaveBeenCalledWith(
      "Usage: superfield deploy provision|deploy [target]",
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.runDeployCommand).not.toHaveBeenCalled();
  });
});
