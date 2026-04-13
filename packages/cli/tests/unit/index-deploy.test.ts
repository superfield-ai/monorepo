import { describe, it, expect, vi, afterEach } from "vitest";
import { runCLI } from "../../index.ts";

const mocks = vi.hoisted(() => ({
  deployCommand: vi.fn(),
}));

vi.mock("../../commands/deploy.ts", () => ({
  deployCommand: mocks.deployCommand,
}));

afterEach(() => {
  vi.restoreAllMocks();
  mocks.deployCommand.mockReset();
});

describe("runCLI deploy", () => {
  it("routes the deploy subcommand to the deploy command", async () => {
    await runCLI(["deploy", "provision", "demo"]);

    expect(mocks.deployCommand).toHaveBeenCalledWith("provision", "demo");
  });
});
