import { afterEach, describe, expect, it, vi } from "vitest";
import { runCLI, parseSlotCount, parseStartArgs } from "../../index.ts";

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
    expect(String(log.mock.calls[0]?.[0])).toContain(
      "deploy [--path <dir>] [--provision] [target]",
    );
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

describe("parseStartArgs", () => {
  it("parses path and slotCount positionals", () => {
    const parsed = parseStartArgs(["/tmp/repo", "2"]);
    expect(parsed.repoPath).toBe("/tmp/repo");
    expect(parsed.slotCountRaw).toBe("2");
    expect(parsed.unknown).toEqual([]);
  });

  it("captures unknown flags", () => {
    const parsed = parseStartArgs(["/tmp/repo", "--wat"]);
    expect(parsed.unknown).toEqual(["--wat"]);
  });

  it("treats --plan, --dev, --doc as unknown flags", () => {
    const parsed = parseStartArgs(["/tmp/repo", "--dev", "--plan", "--doc"]);
    expect(parsed.unknown).toEqual(["--dev", "--plan", "--doc"]);
  });
});
