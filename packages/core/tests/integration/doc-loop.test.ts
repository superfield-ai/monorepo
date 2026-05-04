/**
 * End-to-end documentation loop integration test.
 *
 * The scenarios below that were previously listed as `it.todo` are now either:
 *   - Covered by unit tests in tests/unit/doc-loop.test.ts (see references), or
 *   - Directly exercised here at the integration layer.
 *
 * Unit-test coverage summary (tests/unit/doc-loop.test.ts):
 *   - "processes the newest merged PR on cold start" → "returns idle when…SHA has not changed"
 *     + "runs all three doc tasks for a fresh merged PR"
 *   - "runs coverage → canonical sync → consistency in documented order" →
 *     "executes coverage → canonical sync → consistency in order" (§tickDocLoop)
 *   - "opens a doc PR when canonical sync produces patches" →
 *     "opens a doc PR when canonical sync produces patches" (§tickDocLoop)
 *   - "skips PR when no patches matched the file content" →
 *     "skips PR creation when patches do not match the file content" (§tickDocLoop)
 *   - "skips coverage and consistency tasks when PR has no source files" →
 *     "skips coverage and consistency tasks when no source files in the PR" (§tickDocLoop)
 *   - "lets consistency check see canonical-sync updates before the doc PR is opened" →
 *     covered by the sequential execution test; canonical sync runs before consistency
 *   - "respects CI gating: doc-only changes do not trigger build/test workflows" →
 *     out of scope for unit/integration layer (verified at CI config level)
 *
 * See docs/testing.md §Layer 2.
 */
import { describe, it, expect } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { http, HttpResponse } from "msw";
import { GitHubClient } from "../../../github/client.ts";
import { tickDocLoop } from "../../loops/doc-loop.ts";
import { seedGitHub, type SeedGitHubOpts } from "./helpers/github-msw.ts";
import { replaySpawnSequence } from "../helpers/replay.ts";

const OWNER = "test-org";
const REPO = "test-repo";
const PRD_CONTENT = "# PRD\n\nFeature X section.\n";
const README_CONTENT = "# README\n\nProject overview.\n";

async function createTempRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "doc-loop-test-"));
  await fsp.mkdir(path.join(dir, "src"), { recursive: true });
  await fsp.mkdir(path.join(dir, "docs"), { recursive: true });
  await fsp.writeFile(
    path.join(dir, "src/feature.ts"),
    "export function processFeature() {}\n",
  );
  await fsp.writeFile(path.join(dir, "docs/prd.md"), PRD_CONTENT);
  await fsp.writeFile(path.join(dir, "README.md"), README_CONTENT);
  return dir;
}

describe("doc loop — end to end", () => {
  it(
    "full tick: merged PR triggers all three tasks and opens a doc PR",
    async () => {
      const repoPath = await createTempRepo();
      const github: SeedGitHubOpts = {
        owner: OWNER,
        repo: REPO,
        planBody: "## Queue\n",
        prs: [
          {
            number: 42,
            issueNumber: 0,
            head: "feat/some-feature",
            base: "main",
            state: "closed",
            merged: true,
          },
        ],
      };
      const seeded = seedGitHub(github);
      seeded.server.listen({ onUnhandledRequest: "error" });

      // Override PR files to return a real source file
      seeded.server.use(
        http.get(
          `https://api.github.com/repos/${OWNER}/${REPO}/pulls/42/files`,
          () =>
            HttpResponse.json([
              { filename: "src/feature.ts", status: "modified" },
            ]),
        ),
        // Return actual PRD content so the patch can be applied.
        // Octokit URL-encodes the path, so docs/prd.md becomes docs%2Fprd.md.
        // Use a wildcard and check the decoded URL to match correctly.
        http.get(
          `https://api.github.com/repos/${OWNER}/${REPO}/contents/:filePath*`,
          ({ params }) => {
            const rawPath = String(params.filePath ?? "");
            const decoded = decodeURIComponent(rawPath);
            if (decoded !== "docs/prd.md") return undefined; // pass to next handler
            return HttpResponse.json({
              type: "file",
              sha: "abc123prd",
              content: Buffer.from(PRD_CONTENT).toString("base64"),
              encoding: "base64",
            });
          },
        ),
      );

      const spawn = await replaySpawnSequence([
        "doc-loop-e2e/coverage-with-findings",
        "doc-loop-e2e/canonical-sync-with-patches",
        "doc-loop-e2e/consistency-no-findings",
      ]);
      const client = new GitHubClient("test-token");

      let result: Awaited<ReturnType<typeof tickDocLoop>> | undefined;
      try {
        result = await tickDocLoop({
          client,
          owner: OWNER,
          repo: REPO,
          repoPath,
          spawn,
          lastSeenSha: null,
        });
      } finally {
        seeded.server.close();
        await fsp.rm(repoPath, { recursive: true, force: true });
      }

      expect(result!.idle).toBe(false);
      expect(result!.triggered).toBe(true);
      expect(result!.pr).toBe(42);
      expect(result!.coverageMissing).toHaveLength(1);
      expect(result!.coverageMissing[0]?.symbol).toBe("processFeature");
      expect(result!.canonicalSync).not.toBeNull();
      expect(result!.canonicalSync?.prd_patches).toHaveLength(1);
      expect(result!.docPrNumber).not.toBeNull();
    },
    { timeout: 30000 },
  );

  it(
    "idle: no merged PRs returns triggered=false without calling LLM",
    async () => {
      const repoPath = await createTempRepo();
      const github: SeedGitHubOpts = {
        owner: OWNER,
        repo: REPO,
        planBody: "## Queue\n",
        prs: [], // no PRs at all
      };
      const seeded = seedGitHub(github);
      seeded.server.listen({ onUnhandledRequest: "error" });

      let spawnCallCount = 0;
      const spawn = async () => {
        spawnCallCount++;
        return { sessionId: "unused", output: "{}", isError: false };
      };
      const client = new GitHubClient("test-token");

      let result: Awaited<ReturnType<typeof tickDocLoop>> | undefined;
      try {
        result = await tickDocLoop({
          client,
          owner: OWNER,
          repo: REPO,
          repoPath,
          spawn,
          lastSeenSha: null,
        });
      } finally {
        seeded.server.close();
        await fsp.rm(repoPath, { recursive: true, force: true });
      }

      expect(result!.idle).toBe(true);
      expect(result!.triggered).toBe(false);
      expect(result!.pr).toBeNull();
      expect(spawnCallCount).toBe(0);
    },
    { timeout: 30000 },
  );
});
