import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { tickDocLoop } from "../../loops/doc-loop.ts";
import type { GitHubClient, PullRequest } from "@superfield/github";
import type { AgentOpts, AgentResult } from "../../agent.ts";

let tmpRepo: string;

beforeEach(async () => {
  tmpRepo = await fs.mkdtemp(
    path.join(os.tmpdir(), "superfield-docloop-test-"),
  );
  await fs.mkdir(path.join(tmpRepo, "docs"), { recursive: true });
  await fs.writeFile(
    path.join(tmpRepo, "docs/prd.md"),
    "# PRD\n## Commands\nold text\n",
  );
  await fs.writeFile(path.join(tmpRepo, "README.md"), "# README\n");
});

afterEach(async () => {
  try {
    await fs.rm(tmpRepo, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: "feat: new command",
    body: "Adds a new command",
    html_url: "https://github.com/o/r/pull/42",
    state: "closed",
    merged: true,
    merged_at: "2026-04-08T02:00:00Z",
    base_ref: "main",
    head_ref: "feat/new-command",
    head_sha: "abc123",
    ...overrides,
  };
}

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listMergedPullRequests: vi.fn().mockResolvedValue([]),
    listPullRequestFiles: vi.fn().mockResolvedValue([]),
    getHeadSha: vi.fn().mockResolvedValue("mainsha"),
    createBranch: vi.fn().mockResolvedValue(undefined),
    getFileContents: vi.fn().mockResolvedValue(null),
    putFileContents: vi.fn().mockResolvedValue({ commitSha: "newsha" }),
    createPullRequest: vi
      .fn()
      .mockResolvedValue({ number: 999, html_url: "url" }),
    ...overrides,
  } as unknown as GitHubClient;
}

/** Returns a spawn that emits a different JSON for each consecutive call. */
function multiSpawn(
  responses: unknown[],
): (opts: AgentOpts) => Promise<AgentResult> {
  let idx = 0;
  return async (_opts) => ({
    sessionId: `s-${idx}`,
    output: JSON.stringify(responses[idx++] ?? responses[responses.length - 1]),
    isError: false,
  });
}

describe("tickDocLoop", () => {
  it("returns idle when the main SHA has not changed", async () => {
    const client = makeClient();
    const result = await tickDocLoop({
      client,
      owner: "o",
      repo: "r",
      repoPath: tmpRepo,
      lastSeenSha: "mainsha",
      headSha: "mainsha",
      spawn: multiSpawn([]),
    });
    expect(result.idle).toBe(true);
    expect(result.pr).toBeNull();
    expect(result.triggered).toBe(false);
    expect(client.listMergedPullRequests).not.toHaveBeenCalled();
  });

  it("returns idle when a SHA change does not correspond to a merged PR", async () => {
    const client = makeClient({
      getHeadSha: vi.fn().mockResolvedValue("newsha"),
      listMergedPullRequests: vi.fn().mockResolvedValue([]),
    });
    const result = await tickDocLoop({
      client,
      owner: "o",
      repo: "r",
      repoPath: tmpRepo,
      lastSeenSha: "oldsha",
      spawn: multiSpawn([]),
    });
    expect(result.idle).toBe(true);
    expect(result.triggered).toBe(false);
    expect(result.headSha).toBe("newsha");
  });

  it("runs all three doc tasks for a fresh merged PR", async () => {
    const client = makeClient({
      getHeadSha: vi.fn().mockResolvedValue("newsha"),
      listMergedPullRequests: vi.fn().mockResolvedValue([makePR()]),
      listPullRequestFiles: vi.fn().mockResolvedValue(["packages/core/foo.ts"]),
    });
    const spawn = vi
      .fn()
      .mockImplementation(
        multiSpawn([
          { missing_docs: [] },
          { significant: false, prd_patches: [], readme_patches: [] },
          { inconsistencies: [] },
        ]),
      );
    const result = await tickDocLoop({
      client,
      owner: "o",
      repo: "r",
      repoPath: tmpRepo,
      lastSeenSha: "oldsha",
      spawn,
    });
    expect(result.idle).toBe(false);
    expect(result.pr).toBe(42);
    expect(result.triggered).toBe(true);
    expect(result.headSha).toBe("newsha");
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(result.docPrNumber).toBeNull();
  });

  it("opens a doc PR when canonical sync produces patches", async () => {
    const client = makeClient({
      listMergedPullRequests: vi.fn().mockResolvedValue([makePR()]),
      listPullRequestFiles: vi.fn().mockResolvedValue(["packages/core/foo.ts"]),
      getFileContents: vi.fn().mockResolvedValue({
        content: "# PRD\n## Commands\nold text\n",
        sha: "fileSha",
      }),
    });
    const spawn = vi.fn().mockImplementation(async (opts: AgentOpts) => {
      if (opts.prompt.includes("doc-coverage")) {
        return {
          sessionId: "coverage",
          output: JSON.stringify({ missing_docs: [] }),
          isError: false,
        };
      }
      if (opts.prompt.includes("doc-canonical-sync")) {
        return {
          sessionId: "canonical",
          output: JSON.stringify({
            significant: true,
            rationale: "New command added",
            prd_patches: [
              {
                section: "## Commands",
                old_text: "old text",
                new_text: "new text",
              },
            ],
            readme_patches: [],
          }),
          isError: false,
        };
      }
      return {
        sessionId: "consistency",
        output: JSON.stringify({ inconsistencies: [] }),
        isError: false,
      };
    });
    const result = await tickDocLoop({
      client,
      owner: "o",
      repo: "r",
      repoPath: tmpRepo,
      lastProcessedAt: "2026-04-08T01:00:00Z",
      spawn,
    });
    expect(result.docPrNumber).toBe(999);
    expect(client.createBranch).toHaveBeenCalled();
    expect(client.putFileContents).toHaveBeenCalledTimes(1);
    const putCall = (client.putFileContents as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(putCall.path).toBe("docs/prd.md");
    expect(putCall.content).toContain("new text");
    expect(putCall.content).not.toContain("old text");
    expect(client.createPullRequest).toHaveBeenCalled();
  });

  it("skips PR creation when patches do not match the file content", async () => {
    const client = makeClient({
      listMergedPullRequests: vi.fn().mockResolvedValue([makePR()]),
      listPullRequestFiles: vi.fn().mockResolvedValue(["packages/core/foo.ts"]),
      getFileContents: vi.fn().mockResolvedValue({
        content: "# PRD\n## Commands\nactual text\n",
        sha: "fileSha",
      }),
    });
    const spawn = multiSpawn([
      { missing_docs: [] },
      {
        significant: true,
        prd_patches: [{ old_text: "mismatched", new_text: "replacement" }],
        readme_patches: [],
      },
      { inconsistencies: [] },
    ]);
    const result = await tickDocLoop({
      client,
      owner: "o",
      repo: "r",
      repoPath: tmpRepo,
      lastProcessedAt: "2026-04-08T01:00:00Z",
      spawn,
    });
    expect(result.docPrNumber).toBeNull();
    expect(client.putFileContents).not.toHaveBeenCalled();
    expect(client.createPullRequest).not.toHaveBeenCalled();
  });

  it("skips coverage and consistency tasks when no source files in the PR", async () => {
    const client = makeClient({
      listMergedPullRequests: vi.fn().mockResolvedValue([makePR()]),
      listPullRequestFiles: vi
        .fn()
        .mockResolvedValue(["docs/prd.md", "README.md"]),
    });
    const spawn = vi
      .fn()
      .mockImplementation(
        multiSpawn([
          { significant: false, prd_patches: [], readme_patches: [] },
        ]),
      );
    const result = await tickDocLoop({
      client,
      owner: "o",
      repo: "r",
      repoPath: tmpRepo,
      lastProcessedAt: "2026-04-08T01:00:00Z",
      spawn,
    });
    // Only canonical sync runs (1 LLM call)
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.coverageMissing).toEqual([]);
    expect(result.consistencyFindings).toEqual([]);
  });

  it("skips canonical sync and consistency when neither prd.md nor README exists", async () => {
    // Remove both docs from the temp repo
    await fs.rm(path.join(tmpRepo, "docs/prd.md"));
    await fs.rm(path.join(tmpRepo, "README.md"));

    const client = makeClient({
      listMergedPullRequests: vi.fn().mockResolvedValue([makePR()]),
      listPullRequestFiles: vi.fn().mockResolvedValue(["packages/core/foo.ts"]),
    });
    const spawn = vi.fn().mockImplementation(
      multiSpawn([
        { missing_docs: [] }, // only coverage scan
      ]),
    );
    const result = await tickDocLoop({
      client,
      owner: "o",
      repo: "r",
      repoPath: tmpRepo,
      lastProcessedAt: "2026-04-08T01:00:00Z",
      spawn,
    });
    // Only coverage scan fires — no LLM call for canonical sync or consistency
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.canonicalSync).toBeNull();
    expect(result.consistencyFindings).toEqual([]);
    expect(result.pr).toBe(42);
  });

  it("runs canonical sync when README exists even if prd.md is absent", async () => {
    await fs.rm(path.join(tmpRepo, "docs/prd.md"));

    const client = makeClient({
      listMergedPullRequests: vi.fn().mockResolvedValue([makePR()]),
      listPullRequestFiles: vi.fn().mockResolvedValue(["packages/core/foo.ts"]),
    });
    const spawn = vi
      .fn()
      .mockImplementation(
        multiSpawn([
          { missing_docs: [] },
          { significant: false, prd_patches: [], readme_patches: [] },
          { inconsistencies: [] },
        ]),
      );
    await tickDocLoop({
      client,
      owner: "o",
      repo: "r",
      repoPath: tmpRepo,
      lastProcessedAt: "2026-04-08T01:00:00Z",
      spawn,
    });
    // All 3 tasks still run since README.md exists
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("filters out test files from source-file analysis", async () => {
    const client = makeClient({
      listMergedPullRequests: vi.fn().mockResolvedValue([makePR()]),
      listPullRequestFiles: vi
        .fn()
        .mockResolvedValue([
          "packages/core/foo.ts",
          "packages/core/tests/unit/foo.test.ts",
        ]),
    });
    let coveragePromptFiles: string[] = [];
    const spawn = vi.fn().mockImplementation(async (opts: AgentOpts) => {
      // First call is coverage scan; capture which files were embedded
      if (opts.prompt.includes("doc-coverage")) {
        coveragePromptFiles = ["packages/core/foo.ts"];
      }
      if (opts.prompt.includes("doc-coverage")) {
        return {
          sessionId: "s",
          output: JSON.stringify({ missing_docs: [] }),
          isError: false,
        };
      }
      if (opts.prompt.includes("doc-canonical-sync")) {
        return {
          sessionId: "s",
          output: JSON.stringify({
            significant: false,
            prd_patches: [],
            readme_patches: [],
          }),
          isError: false,
        };
      }
      return {
        sessionId: "s",
        output: JSON.stringify({ inconsistencies: [] }),
        isError: false,
      };
    });
    await tickDocLoop({
      client,
      owner: "o",
      repo: "r",
      repoPath: tmpRepo,
      lastProcessedAt: "2026-04-08T01:00:00Z",
      spawn,
    });
    expect(coveragePromptFiles).toEqual(["packages/core/foo.ts"]);
  });
});
