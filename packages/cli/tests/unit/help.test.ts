import { afterEach, describe, expect, it, vi } from "vitest";
import { runCLI, parseSlotCount } from "../../index.ts";

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

describe("parseSlotCount", () => {
  it("parses a positive integer slot count", () => {
    expect(parseSlotCount("2")).toBe(2);
  });

  it("rejects invalid slot counts", () => {
    expect(parseSlotCount("0")).toBeNull();
    expect(parseSlotCount("abc")).toBeNull();
  });
});
