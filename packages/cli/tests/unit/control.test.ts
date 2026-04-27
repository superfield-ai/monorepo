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
      repo: undefined,
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

  it("--repo /path/to/repo → repo set", () => {
    expect(parseControlArgs(["--repo", "/path/to/repo"]).repo).toBe(
      "/path/to/repo",
    );
  });

  it("--repo=/path → repo set via equals syntax", () => {
    expect(parseControlArgs(["--repo=/path"]).repo).toBe("/path");
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
      "--repo",
      "/app",
      "--api-url",
      "http://x:7837",
    ]);
    expect(r).toMatchObject({
      port: 8000,
      repo: "/app",
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
    _fetch: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response) as unknown as typeof fetch,
    _startControl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("controlCommand", () => {
  afterEach(() => {
    // Clean up any env vars set during tests.
    delete process.env.CONTROL_PORT;
    delete process.env.SUPERFIELD_REPO_ROOT;
    delete process.env.SUPERFIELD_API_URL;
  });

  it("--help → logs usage, does not call _startControl or _fetch", async () => {
    const deps = makeDeps();
    await controlCommand(["--help"], deps);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("superfield control"),
    );
    expect(deps._startControl).not.toHaveBeenCalled();
    expect(deps._fetch).not.toHaveBeenCalled();
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
    expect(output).toContain("--repo");
    expect(output).toContain("--api-url");
  });

  it("unknown flag → warns, logs usage, calls exit(1)", async () => {
    const deps = makeDeps();
    await controlCommand(["--unknown-flag"], deps);
    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining("Unknown arguments"),
    );
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps._startControl).not.toHaveBeenCalled();
  });

  it("--port sets CONTROL_PORT env var", async () => {
    const deps = makeDeps();
    await controlCommand(["--port", "9000"], deps);
    expect(process.env.CONTROL_PORT).toBe("9000");
  });

  it("--repo sets SUPERFIELD_REPO_ROOT env var", async () => {
    const deps = makeDeps();
    await controlCommand(["--repo", "/my/repo"], deps);
    expect(process.env.SUPERFIELD_REPO_ROOT).toBe("/my/repo");
  });

  it("--api-url sets SUPERFIELD_API_URL env var", async () => {
    const deps = makeDeps();
    await controlCommand(["--api-url", "http://remote:7837"], deps);
    expect(process.env.SUPERFIELD_API_URL).toBe("http://remote:7837");
  });

  it("health check 200 → no warning, calls _startControl", async () => {
    const deps = makeDeps();
    await controlCommand([], deps);
    expect(deps.warn).not.toHaveBeenCalled();
    expect(deps._startControl).toHaveBeenCalledOnce();
  });

  it("health check non-200 → warns with HTTP status", async () => {
    const deps = makeDeps({
      _fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      } as Response) as unknown as typeof fetch,
    });
    await controlCommand([], deps);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("503"));
    expect(deps._startControl).toHaveBeenCalledOnce();
  });

  it("health check network error → warns unreachable, still calls _startControl", async () => {
    const deps = makeDeps({
      _fetch: vi
        .fn()
        .mockRejectedValue(
          new Error("ECONNREFUSED"),
        ) as unknown as typeof fetch,
    });
    await controlCommand([], deps);
    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining("unreachable"),
    );
    expect(deps._startControl).toHaveBeenCalledOnce();
  });

  it("health check uses --api-url value", async () => {
    const deps = makeDeps();
    await controlCommand(["--api-url", "http://custom:9999"], deps);
    expect(deps._fetch).toHaveBeenCalledWith(
      expect.stringContaining("http://custom:9999"),
      expect.anything(),
    );
  });
});

// ── controlUsage ──────────────────────────────────────────────────────────────

describe("controlUsage", () => {
  it("includes all three flags", () => {
    const usage = controlUsage();
    expect(usage).toContain("--port");
    expect(usage).toContain("--repo");
    expect(usage).toContain("--api-url");
  });

  it("is a non-empty string", () => {
    expect(controlUsage().length).toBeGreaterThan(20);
  });
});
