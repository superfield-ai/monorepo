import { describe, it, expect } from "vitest";
import { parseAuditArgs } from "../../commands/audit.ts";

describe("parseAuditArgs", () => {
  it("parses --path (space form)", () => {
    const r = parseAuditArgs(["--path", "/home/user/my-app"]);
    expect(r.repoPath).toBe("/home/user/my-app");
    expect(r.noIssues).toBe(false);
    expect(r.unknown).toEqual([]);
  });

  it("parses --path= (equals form)", () => {
    const r = parseAuditArgs(["--path=/home/user/my-app"]);
    expect(r.repoPath).toBe("/home/user/my-app");
  });

  it("parses --repo", () => {
    const r = parseAuditArgs(["--path", "/p", "--repo", "owner/repo"]);
    expect(r.repo).toBe("owner/repo");
  });

  it("parses --capabilities as comma-separated list", () => {
    const r = parseAuditArgs([
      "--path",
      "/p",
      "--capabilities",
      "pwa,authentication",
    ]);
    expect(r.capabilities).toEqual(["pwa", "authentication"]);
  });

  it("parses --capabilities= (equals form)", () => {
    const r = parseAuditArgs(["--path", "/p", "--capabilities=error-tracing"]);
    expect(r.capabilities).toEqual(["error-tracing"]);
  });

  it("trims whitespace in capability list", () => {
    const r = parseAuditArgs([
      "--path",
      "/p",
      "--capabilities",
      " pwa , authentication ",
    ]);
    expect(r.capabilities).toEqual(["pwa", "authentication"]);
  });

  it("parses --no-issues flag", () => {
    const r = parseAuditArgs(["--path", "/p", "--no-issues"]);
    expect(r.noIssues).toBe(true);
  });

  it("parses --output-dir", () => {
    const r = parseAuditArgs(["--path", "/p", "--output-dir", "/tmp/audit"]);
    expect(r.outputDir).toBe("/tmp/audit");
  });

  it("collects unknown flags", () => {
    const r = parseAuditArgs(["--path", "/p", "--unknown-flag"]);
    expect(r.unknown).toEqual(["--unknown-flag"]);
  });

  it("returns undefined repoPath when --path is omitted", () => {
    const r = parseAuditArgs(["--repo", "owner/repo"]);
    expect(r.repoPath).toBeUndefined();
  });
});
