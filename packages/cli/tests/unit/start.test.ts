/**
 * Unit tests for packages/cli/commands/start.ts
 *
 * Issue #1: wire all three loops (planning, dev, doc) into startCommand.
 * Verifies that all three loops are started concurrently and each receives
 * correct owner/repo/repoPath args.
 */
import { describe, it, expect, vi } from "vitest";
import { startCommand, type StartDeps } from "../../commands/start.ts";

function makeDeps(overrides: Partial<StartDeps> = {}): StartDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue({
      users: [{ handle: "alice", token: "ghp_tok" }],
      repositories: [{ owner: "org", repo: "myrepo", assignedUser: "alice" }],
    }),
    resolveRepo: vi.fn().mockResolvedValue({ owner: "org", repo: "myrepo" }),
    runPlanningLoop: vi.fn().mockResolvedValue(undefined),
    runDevLoop: vi.fn().mockResolvedValue(undefined),
    runDocLoop: vi.fn().mockResolvedValue(undefined),
    env: {},
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as StartDeps["exit"],
    ...overrides,
  };
}

describe("startCommand", () => {
  it("starts all three loops when called with a valid repo path", async () => {
    const deps = makeDeps();
    await startCommand("/home/user/project", deps);

    expect(deps.runPlanningLoop).toHaveBeenCalledOnce();
    expect(deps.runDevLoop).toHaveBeenCalledOnce();
    expect(deps.runDocLoop).toHaveBeenCalledOnce();
  });

  it("passes owner and repo to all three loops", async () => {
    const deps = makeDeps();
    await startCommand("/home/user/project", deps);

    const planArg = (deps.runPlanningLoop as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(planArg).toMatchObject({
      repositories: [expect.objectContaining({ owner: "org", repo: "myrepo" })],
    });

    const devArg = (deps.runDevLoop as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(devArg).toMatchObject({ owner: "org", repo: "myrepo" });

    const docArg = (deps.runDocLoop as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(docArg).toMatchObject({ owner: "org", repo: "myrepo" });
  });

  it("passes the repoPath to the doc loop", async () => {
    const deps = makeDeps();
    await startCommand("/home/user/project", deps);

    const docArg = (deps.runDocLoop as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(docArg.repoPath).toBe("/home/user/project");
  });

  it("passes an explicit slotCount through to the dev loop", async () => {
    const deps = makeDeps({ slotCount: 2 });
    await startCommand("/home/user/project", deps);

    const devArg = (deps.runDevLoop as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(devArg.slotCount).toBe(2);
  });

  it("passes SUPERFIELD_SLOT_COUNT through to the dev loop", async () => {
    const deps = makeDeps({ env: { SUPERFIELD_SLOT_COUNT: "2" } });
    await startCommand("/home/user/project", deps);

    const devArg = (deps.runDevLoop as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(devArg.slotCount).toBe(2);
  });

  it.each(["abc", "0"])(
    "warns and falls back when SUPERFIELD_SLOT_COUNT=%s",
    async (raw) => {
      const deps = makeDeps({ env: { SUPERFIELD_SLOT_COUNT: raw } });
      await startCommand("/home/user/project", deps);

      expect(deps.warn).toHaveBeenCalledWith(
        `[warn] Ignoring invalid SUPERFIELD_SLOT_COUNT=${JSON.stringify(raw)}; using the default slot count`,
      );
      const devArg = (deps.runDevLoop as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(devArg.slotCount).toBeUndefined();
    },
  );

  it("omits slotCount when none is configured", async () => {
    const deps = makeDeps();
    await startCommand("/home/user/project", deps);

    const devArg = (deps.runDevLoop as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(devArg.slotCount).toBeUndefined();
  });

  it("exits with error when no repoPath is given", async () => {
    const exit = vi.fn() as unknown as StartDeps["exit"];
    const deps = makeDeps({ exit });
    await startCommand(undefined, deps);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits with error when no users are configured", async () => {
    const exit = vi.fn() as unknown as StartDeps["exit"];
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue({ users: [], repositories: [] }),
      exit,
    });
    await startCommand("/home/user/project", deps);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
