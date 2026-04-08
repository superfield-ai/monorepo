/**
 * Compile-time and runtime test for GitHubClientPort interface.
 *
 * Issue #10: extracting GitHubClientPort allows test doubles to be typed
 * correctly without `as unknown as GitHubClient` escape hatches.
 */
import { describe, it, expect, vi } from "vitest";
import type { GitHubClientPort } from "../../client.ts";
import { GitHubClient } from "../../client.ts";

describe("GitHubClientPort", () => {
  it("a plain object satisfying the interface compiles without casts", () => {
    // If this compiles (no `as unknown as GitHubClient`), the interface works
    const port: GitHubClientPort = {
      getHeadSha: vi.fn().mockResolvedValue("sha"),
      getCheckRuns: vi.fn().mockResolvedValue([]),
      getIssue: vi.fn(),
      listIssues: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn(),
      updateIssueBody: vi.fn(),
      listIssueComments: vi.fn().mockResolvedValue([]),
      createIssueComment: vi.fn(),
      updateIssueComment: vi.fn(),
      addIssueLabel: vi.fn(),
      removeIssueLabel: vi.fn(),
      deleteIssueComment: vi.fn(),
      listMergedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestFiles: vi.fn().mockResolvedValue([]),
      createBranch: vi.fn(),
      putFileContents: vi.fn(),
      getFileContents: vi.fn().mockResolvedValue(null),
      createPullRequest: vi.fn(),
    };
    // Verify at runtime that the interface methods are present
    expect(typeof port.getHeadSha).toBe("function");
    expect(typeof port.listIssues).toBe("function");
  });

  it("GitHubClient satisfies GitHubClientPort (structural typing)", () => {
    // GitHubClient now explicitly implements GitHubClientPort
    // This is a compile-time check that GitHubClient has all required methods
    const client = new GitHubClient("fake-token");
    // If TypeScript accepts this assignment, the class satisfies the interface
    const port: GitHubClientPort = client;
    expect(typeof port.getHeadSha).toBe("function");
  });
});
