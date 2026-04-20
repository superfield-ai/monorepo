import { describe, it, expect } from "vitest";
import { parseSetupGithubArgs } from "../../commands/setup-github.ts";

describe("parseSetupGithubArgs", () => {
  it("parses --deploy-key with --env and --repo (space form)", () => {
    expect(
      parseSetupGithubArgs([
        "--deploy-key",
        "--env",
        "demo",
        "--repo",
        "owner/name",
      ]),
    ).toEqual({
      deployKey: true,
      secrets: false,
      env: "demo",
      repo: "owner/name",
      host: undefined,
      databaseUrl: undefined,
      unknown: [],
    });
  });

  it("parses --env=value and --repo=value (equals form)", () => {
    expect(
      parseSetupGithubArgs([
        "--deploy-key",
        "--env=staging",
        "--repo=acme/app",
      ]),
    ).toEqual({
      deployKey: true,
      secrets: false,
      env: "staging",
      repo: "acme/app",
      host: undefined,
      databaseUrl: undefined,
      unknown: [],
    });
  });

  it("collects unknown flags into `unknown`", () => {
    expect(
      parseSetupGithubArgs(["--deploy-key", "--surprise", "--env", "demo"]),
    ).toEqual({
      deployKey: true,
      secrets: false,
      env: "demo",
      repo: undefined,
      host: undefined,
      databaseUrl: undefined,
      unknown: ["--surprise"],
    });
  });
});
