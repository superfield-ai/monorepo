import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  controlCommand,
  type ControlCommandDeps,
} from "../../commands/control.ts";

function findTemplatePath(): string | null {
  const fromEnv = process.env.TEMPLATE_REPO_PATH;
  if (fromEnv) {
    return existsSync(fromEnv) ? fromEnv : null;
  }
  const sibling = resolve(import.meta.dirname, "../../../../../template");
  return existsSync(sibling) ? sibling : null;
}

const d = findTemplatePath() ? describe : describe.skip;

function makeDeps(
  overrides: Partial<ControlCommandDeps> = {},
): ControlCommandDeps {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    exit: vi.fn() as unknown as ControlCommandDeps["exit"],
    _buildControlWeb: vi.fn().mockResolvedValue(undefined),
    // _startSfServe resolves immediately — the binary is not available in CI.
    _startSfServe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

d("controlCommand integration: template path wiring", () => {
  const TEMPLATE_REPO = findTemplatePath()!;
  afterEach(() => {
    delete process.env.SUPERFIELD_REPO_ROOT;
    delete process.env.CONTROL_SOURCE_DIR;
    delete process.env.SUPERFIELD_API_URL;
    delete process.env.CONTROL_PORT;
    delete process.env.CONTROL_ASSETS_DIR;
  });

  it("calls _startSfServe once with the template project root, applies env vars", async () => {
    const deps = makeDeps();
    await controlCommand(
      ["--path", TEMPLATE_REPO, "--api-url", "http://127.0.0.1:7837"],
      deps,
    );

    expect(deps.warn).not.toHaveBeenCalled();
    expect(deps._buildControlWeb).toHaveBeenCalledTimes(1);
    expect(deps._startSfServe).toHaveBeenCalledTimes(1);
    expect(deps._startSfServe).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: TEMPLATE_REPO }),
    );

    expect(process.env.SUPERFIELD_REPO_ROOT).toBe(TEMPLATE_REPO);
    expect(process.env.CONTROL_SOURCE_DIR).toBe(TEMPLATE_REPO);
    expect(process.env.SUPERFIELD_API_URL).toBe("http://127.0.0.1:7837");
  });

  it("--port 7123 sets CONTROL_PORT env var to '7123'", async () => {
    const deps = makeDeps();
    await controlCommand(
      [
        "--port",
        "7123",
        "--path",
        TEMPLATE_REPO,
        "--api-url",
        "http://127.0.0.1:7837",
      ],
      deps,
    );

    expect(deps._buildControlWeb).toHaveBeenCalledTimes(1);
    expect(process.env.CONTROL_PORT).toBe("7123");
    expect(deps._startSfServe).toHaveBeenCalledWith(
      expect.objectContaining({ port: 7123 }),
    );
  });
});
