import { describe, it, expect } from "vitest";
import { parseDoctorArgs } from "../../commands/doctor.ts";

describe("parseDoctorArgs", () => {
  it("parses --env and --repo flags", () => {
    const result = parseDoctorArgs([
      "--env",
      "staging",
      "--repo",
      "my-org/my-repo",
    ]);
    expect(result.env).toBe("staging");
    expect(result.repo).toBe("my-org/my-repo");
    expect(result.json).toBe(false);
    expect(result.unknown).toEqual([]);
  });

  it("parses --env=value form", () => {
    const result = parseDoctorArgs(["--env=prod", "--repo=org/repo"]);
    expect(result.env).toBe("prod");
    expect(result.repo).toBe("org/repo");
  });

  it("parses --json flag", () => {
    const result = parseDoctorArgs([
      "--env",
      "demo",
      "--repo",
      "a/b",
      "--json",
    ]);
    expect(result.json).toBe(true);
  });

  it("collects unknown flags", () => {
    const result = parseDoctorArgs([
      "--env",
      "demo",
      "--repo",
      "a/b",
      "--unknown",
    ]);
    expect(result.unknown).toEqual(["--unknown"]);
  });

  it("returns undefined for missing required flags", () => {
    const result = parseDoctorArgs([]);
    expect(result.env).toBeUndefined();
    expect(result.repo).toBeUndefined();
  });

  it("parses --backend fastenv and --backend k3s", () => {
    expect(parseDoctorArgs(["--backend", "fastenv"]).backend).toBe("fastenv");
    expect(parseDoctorArgs(["--backend=k3s"]).backend).toBe("k3s");
  });

  it("leaves backend undefined when not supplied (defaults to fastenv downstream)", () => {
    const result = parseDoctorArgs(["--env", "demo", "--repo", "a/b"]);
    expect(result.backend).toBeUndefined();
  });

  it("rejects an unknown backend value", () => {
    const result = parseDoctorArgs(["--backend", "docker"]);
    expect(result.backend).toBeUndefined();
    expect(result.unknown).toContain("--backend docker");
  });
});
