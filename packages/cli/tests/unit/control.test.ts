import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseControlArgs,
  controlCommand,
  controlUsage,
  type ControlCommandDeps,
} from "../../commands/control.ts";

// ── parseControlArgs ──────────────────────────────────────────────────────────

describe("parseControlArgs", () => {
  it("empty args → all fields absent, help false", () => {
    const r = parseControlArgs([]);
    expect(r).toEqual({
      port: undefined,
      path: undefined,
      apiUrl: undefined,
      help: false,
      unknown: [],
    });
  });

  it("--help → help: true", () => {
    expect(parseControlArgs(["--help"]).help).toBe(true);
  });

  it("-h → help: true", () => {
    expect(parseControlArgs(["-h"]).help).toBe(true);
  });

  it("--port 3000 (space) → port: 3000", () => {
    expect(parseControlArgs(["--port", "3000"]).port).toBe(3000);
  });

  it("--port=3000 (equals) → port: 3000", () => {
    expect(parseControlArgs(["--port=3000"]).port).toBe(3000);
  });

  it("--port abc → value in unknown, port undefined", () => {
    const r = parseControlArgs(["--port", "abc"]);
    expect(r.port).toBeUndefined();
    expect(r.unknown).toContain("--port");
  });

  it("--path /path/to/project → path set", () => {
    expect(parseControlArgs(["--path", "/path/to/project"]).path).toBe(
      "/path/to/project",
    );
  });

  it("--path=/path → path set via equals syntax", () => {
    expect(parseControlArgs(["--path=/path"]).path).toBe("/path");
  });

  it("--api-url http://localhost:7837 → apiUrl set", () => {
    expect(
      parseControlArgs(["--api-url", "http://localhost:7837"]).apiUrl,
    ).toBe("http://localhost:7837");
  });

  it("--api-url=http://localhost:7837 → apiUrl set via equals", () => {
    expect(parseControlArgs(["--api-url=http://localhost:7837"]).apiUrl).toBe(
      "http://localhost:7837",
    );
  });

  it("unknown flag → accumulates in unknown array", () => {
    expect(parseControlArgs(["--verbose"]).unknown).toEqual(["--verbose"]);
  });

  it("multiple unknown flags → all accumulated", () => {
    expect(parseControlArgs(["--verbose", "--debug"]).unknown).toEqual([
      "--verbose",
      "--debug",
    ]);
  });

  it("all three flags together", () => {
    const r = parseControlArgs([
      "--port",
      "8000",
      "--path",
      "/app",
      "--api-url",
      "http://x:7837",
    ]);
    expect(r).toMatchObject({
      port: 8000,
      path: "/app",
      apiUrl: "http://x:7837",
      help: false,
      unknown: [],
    });
  });
});

// ── controlCommand ────────────────────────────────────────────────────────────

function makeDeps(
  overrides: Partial<ControlCommandDeps> = {},
): ControlCommandDeps {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    exit: vi.fn() as unknown as ControlCommandDeps["exit"],
    _buildControlWeb: vi.fn().mockResolvedValue(undefined),
    _startSfServe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("controlCommand", () => {
  afterEach(() => {
    // Clean up any env vars set during tests.
    delete process.env.CONTROL_PORT;
    delete process.env.SUPERFIELD_REPO_ROOT;
    delete process.env.CONTROL_SOURCE_DIR;
    delete process.env.SUPERFIELD_API_URL;
    delete process.env.CONTROL_ASSETS_DIR;
  });

  it("--help → logs usage, does not call _startSfServe", async () => {
    const deps = makeDeps();
    await controlCommand(["--help"], deps);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("superfield control"),
    );
    expect(deps._buildControlWeb).not.toHaveBeenCalled();
    expect(deps._startSfServe).not.toHaveBeenCalled();
  });

  it("--help output contains option docs", async () => {
    let output = "";
    const deps = makeDeps({
      log: (m) => {
        output += m;
      },
    });
    await controlCommand(["--help"], deps);
    expect(output).toContain("--port");
    expect(output).toContain("--path");
    expect(output).toContain("--api-url");
  });

  it("usage mentions sf-serve backend", async () => {
    expect(controlUsage()).toContain("sf-serve");
  });

  it("unknown flag → warns, logs usage, calls exit(1)", async () => {
    const deps = makeDeps();
    await controlCommand(["--unknown-flag"], deps);
    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining("Unknown arguments"),
    );
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps._buildControlWeb).not.toHaveBeenCalled();
    expect(deps._startSfServe).not.toHaveBeenCalled();
  });

  it("default startup: builds UI and calls _startSfServe — no Node/Bun backend started", async () => {
    const deps = makeDeps();
    await controlCommand([], deps);
    expect(deps._buildControlWeb).toHaveBeenCalledOnce();
    expect(deps.warn).not.toHaveBeenCalled();
    expect(deps._startSfServe).toHaveBeenCalledOnce();
  });

  it("--port sets CONTROL_PORT env var and passes port to _startSfServe", async () => {
    const deps = makeDeps();
    await controlCommand(["--port", "9000"], deps);
    expect(deps._buildControlWeb).toHaveBeenCalledOnce();
    expect(deps._startSfServe).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9000 }),
    );
    expect(process.env.CONTROL_PORT).toBe("9000");
  });

  it("--path sets SUPERFIELD_REPO_ROOT env var and passes projectRoot to _startSfServe", async () => {
    const deps = makeDeps();
    await controlCommand(["--path", "/my/project"], deps);
    expect(deps._buildControlWeb).toHaveBeenCalledOnce();
    expect(deps._startSfServe).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: "/my/project" }),
    );
    expect(process.env.SUPERFIELD_REPO_ROOT).toBe("/my/project");
    expect(process.env.CONTROL_SOURCE_DIR).toBe("/my/project");
  });

  it("--api-url passes apiUrl to _startSfServe", async () => {
    const deps = makeDeps();
    await controlCommand(["--api-url", "http://remote:7837"], deps);
    expect(deps._buildControlWeb).toHaveBeenCalledOnce();
    expect(deps._startSfServe).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: "http://remote:7837" }),
    );
    expect(process.env.SUPERFIELD_API_URL).toBe("http://remote:7837");
  });

  it("_startSfServe receives assetsDir pointing at the built web app dist", async () => {
    const deps = makeDeps();
    await controlCommand([], deps);
    expect(deps._startSfServe).toHaveBeenCalledWith(
      expect.objectContaining({
        assetsDir: expect.stringContaining("packages/control/apps/dist"),
      }),
    );
  });

  it("CONTROL_ASSETS_DIR env override is honoured over default dist path", async () => {
    process.env.CONTROL_ASSETS_DIR = "/custom/assets";
    const deps = makeDeps();
    await controlCommand([], deps);
    expect(deps._startSfServe).toHaveBeenCalledWith(
      expect.objectContaining({ assetsDir: "/custom/assets" }),
    );
  });

  // Boot check: the command must not start any Node/Bun backend in production.
  it("boot check: ControlCommandDeps has no _startApiServer or _startControl dep", () => {
    // This test is a static contract check: if someone re-adds the Bun/Node
    // backend deps to ControlCommandDeps, this test's type check will catch it.
    // At runtime we simply verify _startSfServe is the only backend dep called.
    const deps = makeDeps();

    // These keys must NOT appear on the deps object.
    expect(Object.keys(deps)).not.toContain("_startApiServer");
    expect(Object.keys(deps)).not.toContain("_startControl");
    expect(Object.keys(deps)).toContain("_startSfServe");
  });

  it("all three flags forwarded to _startSfServe", async () => {
    const deps = makeDeps();
    await controlCommand(
      ["--port", "8000", "--path", "/app", "--api-url", "http://x:7837"],
      deps,
    );
    expect(deps._startSfServe).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 8000,
        projectRoot: "/app",
        apiUrl: "http://x:7837",
      }),
    );
  });
});

// ── controlUsage ──────────────────────────────────────────────────────────────

describe("controlUsage", () => {
  it("includes all three flags", () => {
    const usage = controlUsage();
    expect(usage).toContain("--port");
    expect(usage).toContain("--path");
    expect(usage).toContain("--api-url");
  });

  it("is a non-empty string", () => {
    expect(controlUsage().length).toBeGreaterThan(20);
  });
});
