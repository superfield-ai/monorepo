import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  controlCommand,
  type ControlCommandDeps,
} from "../../commands/control.ts";

function resolveTemplatePath(): string {
  const fromEnv = process.env.TEMPLATE_REPO_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`TEMPLATE_REPO_PATH=${fromEnv} does not exist.`);
    }
    return fromEnv;
  }
  const sibling = resolve(import.meta.dirname, "../../../../../template");
  if (existsSync(sibling)) return sibling;
  throw new Error(
    `Could not locate template repo. Set TEMPLATE_REPO_PATH or check out ` +
      `superfield-ai/superfield-starter-ts at ${sibling}.`,
  );
}

const TEMPLATE_REPO = resolveTemplatePath();

function makeDeps(
  overrides: Partial<ControlCommandDeps> = {},
): ControlCommandDeps {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    exit: vi.fn() as unknown as ControlCommandDeps["exit"],
    // Real fetch — we want the actual TCP probe against 127.0.0.1:1 to fail.
    _fetch: globalThis.fetch,
    _startControl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("controlCommand integration: template + closed API port", () => {
  afterEach(() => {
    delete process.env.SUPERFIELD_REPO_ROOT;
    delete process.env.SUPERFIELD_API_URL;
    delete process.env.CONTROL_PORT;
  });

  it("warns 'unreachable', calls _startControl once, applies env vars", async () => {
    const deps = makeDeps();
    await controlCommand(
      ["--repo", TEMPLATE_REPO, "--api-url", "http://127.0.0.1:1"],
      deps,
    );

    const warnMock = deps.warn as ReturnType<typeof vi.fn>;
    const calls = warnMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes("unreachable"))).toBe(true);

    expect(deps._startControl).toHaveBeenCalledTimes(1);

    expect(process.env.SUPERFIELD_REPO_ROOT).toBe(TEMPLATE_REPO);
    expect(process.env.SUPERFIELD_API_URL).toBe("http://127.0.0.1:1");
  });

  it("--port 7123 sets CONTROL_PORT env var to '7123'", async () => {
    const deps = makeDeps();
    await controlCommand(
      [
        "--port",
        "7123",
        "--repo",
        TEMPLATE_REPO,
        "--api-url",
        "http://127.0.0.1:1",
      ],
      deps,
    );

    expect(process.env.CONTROL_PORT).toBe("7123");
  });
});
