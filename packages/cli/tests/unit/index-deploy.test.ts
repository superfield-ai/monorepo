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
    // Verify that a no-args `deploy` call reaches runDeployCommand with
    // provisionOnly: false. We inject SIGINT so the subsequent waitForSigint
    // resolves without relying on an actual signal from outside.
    let sigintListener: (() => void) | undefined;
    const origOnce = process.once.bind(process);
    vi.spyOn(process, "once").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (event: any, listener: any) => {
        if (event === "SIGINT") {
          sigintListener = listener;
          return process;
        }
        return origOnce(event, listener);
      },
    );

    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const { runCLI } = await import("../../index.ts");

    // Run in background, then resolve waitForSigint by calling the captured
    // listener directly once it has been registered.
    const runPromise = runCLI(["deploy"]).catch(() => undefined);

    // Poll until waitForSigint's listener is registered, then fire it.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (sigintListener) {
          sigintListener();
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      setTimeout(check, 10);
    });

    await runPromise;

    expect(mocks.runDeployCommand).toHaveBeenCalledWith({
      provisionOnly: false,
    });
  });
});
