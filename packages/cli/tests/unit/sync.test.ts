import { describe, it, expect } from "vitest";
import { parseSyncArgs } from "../../commands/sync.ts";

describe("parseSyncArgs", () => {
  it("parses --repo and --app-name (space form)", () => {
    const r = parseSyncArgs([
      "--repo",
      "owner/name",
      "--app-name",
      "my-app",
    ]);
    expect(r.repo).toBe("owner/name");
    expect(r.appName).toBe("my-app");
    expect(r.imageRepo).toBeUndefined();
    expect(r.deployments).toBeUndefined();
    expect(r.unknown).toEqual([]);
  });

  it("parses --image-repo and --deployments (equals form)", () => {
    const r = parseSyncArgs([
      "--repo=owner/name",
      "--app-name=my-app",
      "--image-repo=ghcr.io/foo/bar",
      "--deployments=app,worker,scheduler",
    ]);
    expect(r.repo).toBe("owner/name");
    expect(r.appName).toBe("my-app");
    expect(r.imageRepo).toBe("ghcr.io/foo/bar");
    expect(r.deployments).toEqual(["app", "worker", "scheduler"]);
    expect(r.unknown).toEqual([]);
  });

  it("trims and drops empty entries from --deployments", () => {
    const r = parseSyncArgs([
      "--repo",
      "o/n",
      "--app-name",
      "a",
      "--deployments",
      " app , , worker ",
    ]);
    expect(r.deployments).toEqual(["app", "worker"]);
  });

  it("collects unknown flags", () => {
    const r = parseSyncArgs(["--repo", "o/n", "--what", "x"]);
    expect(r.unknown).toEqual(["--what", "x"]);
  });
});
