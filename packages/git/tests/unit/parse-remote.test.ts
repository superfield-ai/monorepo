import { describe, it, expect } from "vitest";
import { parseGitHubRemote } from "../../client.ts";

describe("parseGitHubRemote", () => {
  it("parses https remote with .git suffix", () => {
    const r = parseGitHubRemote(
      "https://github.com/dot-matrix-labs/superfield-ts.git",
    );
    expect(r).toEqual({ owner: "dot-matrix-labs", repo: "superfield-ts" });
  });

  it("parses https remote without .git suffix", () => {
    const r = parseGitHubRemote(
      "https://github.com/dot-matrix-labs/superfield-ts",
    );
    expect(r).toEqual({ owner: "dot-matrix-labs", repo: "superfield-ts" });
  });

  it("parses ssh remote", () => {
    const r = parseGitHubRemote(
      "git@github.com:dot-matrix-labs/superfield-ts.git",
    );
    expect(r).toEqual({ owner: "dot-matrix-labs", repo: "superfield-ts" });
  });

  it("parses ssh remote with host alias", () => {
    const r = parseGitHubRemote(
      "git@github-lucky:superfield-ai/superfield-starter-ts",
    );
    expect(r).toEqual({
      owner: "superfield-ai",
      repo: "superfield-starter-ts",
    });
  });

  it("throws on non-GitHub remote", () => {
    expect(() =>
      parseGitHubRemote("https://gitlab.com/owner/repo.git"),
    ).toThrow("Cannot parse GitHub remote URL");
  });
});
