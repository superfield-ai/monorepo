import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runDeployCommand: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@superfield/core");
  mocks.runDeployCommand.mockReset();
});

describe("runCLI deploy", () => {
  it("routes the deploy subcommand to the deploy command", async () => {
    vi.doMock("@superfield/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@superfield/core")>();
      return {
        ...actual,
        runDeployCommand: mocks.runDeployCommand,
      };
    });

    const { runCLI } = await import("../../index.ts");
    await runCLI(["deploy", "--provision", "demo"]);

    expect(mocks.runDeployCommand).toHaveBeenCalledWith({
      provisionOnly: true,
      target: "demo",
    });
  });

  it("passes the default deploy flow through to core", async () => {
    vi.doMock("@superfield/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@superfield/core")>();
      return {
        ...actual,
        runDeployCommand: mocks.runDeployCommand,
      };
    });

    const { runCLI } = await import("../../index.ts");
    await runCLI(["deploy"]);

    expect(mocks.runDeployCommand).toHaveBeenCalledWith({
      provisionOnly: false,
    });
  });
});
