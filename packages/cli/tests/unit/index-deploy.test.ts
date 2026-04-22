import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runDeployCommand: vi.fn(),
  runDemoTeardown: vi.fn(),
}));

vi.mock("@superfield/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@superfield/core")>();
  return {
    ...actual,
    runDeployCommand: mocks.runDeployCommand,
    runDemoTeardown: mocks.runDemoTeardown,
    DEFAULT_DEMO_PORT: 58080,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.runDeployCommand.mockReset();
  mocks.runDemoTeardown.mockReset();
});

describe("runCLI deploy", () => {
  it("routes the deploy subcommand to the deploy command", async () => {
    // Use --provision so deployCommand returns early after calling
    // runDeployCommand, without blocking on waitForSigint. The full
    // non-provision deploy flow (waitForSigint, teardown) is covered by
    // deploy.test.ts which uses injectable deps.
    const { runCLI } = await import("../../index.ts");
    await runCLI(["deploy", "--provision", "demo"]);

    expect(mocks.runDeployCommand).toHaveBeenCalledWith({
      provisionOnly: true,
      target: "demo",
    });
  });

  it("passes the default deploy flow through to core", async () => {
    mocks.runDeployCommand.mockResolvedValue(undefined);
    mocks.runDemoTeardown.mockResolvedValue(undefined);

    vi.doMock("@superfield/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@superfield/core")>();
      return {
        ...actual,
        runDeployCommand: mocks.runDeployCommand,
        runDemoTeardown: mocks.runDemoTeardown,
        DEFAULT_DEMO_PORT: 58080,
      };
    });

    const { runCLI } = await import("../../index.ts");

    // Inject no-op deps so the test doesn't hang waiting for SIGINT or a
    // live network call. process.exit is called after teardown, so mock it.
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    await runCLI(["deploy"], {
      deployCommandDeps: {
        fetchPublicIp: async () => null,
        waitForExit: async () => undefined,
      },
    });

    mockExit.mockRestore();

    expect(mocks.runDeployCommand).toHaveBeenCalledWith({
      provisionOnly: false,
    });
  });
});
