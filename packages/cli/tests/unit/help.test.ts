import { afterEach, describe, expect, it, vi } from "vitest";
import { runCLI } from "../../index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCLI help", () => {
  it("prints build metadata with --help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCLI(["--help"]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/Version: .+/);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/Commit: .+/);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/Build date: .+/);
  });
});
