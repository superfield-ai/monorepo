/**
 * Records real `claude --print --output-format json` responses as test
 * fixtures for the integration test layer (Layer 2).
 *
 * Usage:
 *   bun record-claude-fixtures <task-name> [--repo <owner/repo>] [--issue <n>]
 *   bun record-claude-fixtures --list
 *
 * The script builds the appropriate prompt for the named task using the
 * same builder the production code calls, spawns the real `claude` CLI,
 * and writes the result to `tests/fixtures/claude/<task-name>.json`.
 *
 * Requires:
 *   - `claude` CLI on PATH
 *   - GITHUB_TOKEN env var (read access to the source repo)
 *
 * Refresh fixtures only when:
 *   1. A prompt builder changes
 *   2. Claude's CLI JSON output format changes
 *   3. A task's expected output schema changes
 *
 * See `docs/testing.md` §Layer 2.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnAgent } from "../packages/core/agent.ts";
import { GitHubClient } from "../packages/github/client.ts";
import {
  buildIssueAuditPrompt,
  buildBlueprintConformancePrompt,
  buildFeatureEvaluatePrompt,
  buildFeatureNarrowPrompt,
  buildReplanEvaluatePrompt,
  buildDocCoveragePrompt,
  buildDocCanonicalSyncPrompt,
  buildDocConsistencyPrompt,
  buildDevelopIssuePrompt,
  buildPrePRSelfAuditPrompt,
} from "../packages/core/prompts/index.ts";

const FIXTURES_DIR = path.resolve(
  import.meta.dirname,
  "../tests/fixtures/claude",
);

interface RecorderArgs {
  task: string;
  repo?: string;
  issueNumber?: number;
}

interface TaskRecorder {
  description: string;
  build(
    args: RecorderArgs,
  ): Promise<{ prompt: string; metadata: Record<string, unknown> }>;
}

const RECORDERS: Record<string, TaskRecorder> = {
  "issue-audit-conformant": {
    description:
      "Issue audit on a well-formed feature issue (no missing sections)",
    async build(args) {
      const issue = await fetchIssue(args);
      return {
        prompt: buildIssueAuditPrompt({ issues: [issue] }),
        metadata: {
          repo: args.repo,
          issue_number: issue.number,
          scenario: "conformant",
        },
      };
    },
  },

  "issue-audit-non-conformant": {
    description: "Issue audit on an issue missing required sections",
    async build(args) {
      const issue = await fetchIssue(args);
      return {
        prompt: buildIssueAuditPrompt({ issues: [issue] }),
        metadata: {
          repo: args.repo,
          issue_number: issue.number,
          scenario: "non-conformant",
        },
      };
    },
  },

  "blueprint-conformance-arch-violation": {
    description: "Blueprint conformance check that should flag an ARCH rule",
    async build(args) {
      const issue = await fetchIssue(args);
      return {
        prompt: buildBlueprintConformancePrompt({
          issue,
          candidateDomains: ["arch"],
        }),
        metadata: {
          repo: args.repo,
          issue_number: issue.number,
          scenario: "arch-violation",
        },
      };
    },
  },

  "feature-evaluate-new": {
    description: "Feature-evaluate on a brand-new feature request",
    async build(args) {
      const { client, owner, repo } = await ghClientFor(args);
      const issues = await client.listIssues(owner, repo);
      return {
        prompt: buildFeatureEvaluatePrompt({
          request: "Add a logout button to the navbar that clears the session",
          planBody: null,
          openIssueTitles: issues.map((i) => ({
            number: i.number,
            title: i.title,
          })),
          candidateDomains: ["auth", "ux"],
        }),
        metadata: { repo: args.repo, scenario: "new-feature" },
      };
    },
  },

  "feature-evaluate-duplicate": {
    description:
      "Feature-evaluate on a request that duplicates an existing issue",
    async build(args) {
      const { client, owner, repo } = await ghClientFor(args);
      const issues = await client.listIssues(owner, repo);
      const target = issues[0];
      if (!target)
        throw new Error("No open issues to use as a duplicate target");
      return {
        prompt: buildFeatureEvaluatePrompt({
          request: target.title,
          planBody: null,
          openIssueTitles: issues.map((i) => ({
            number: i.number,
            title: i.title,
          })),
          candidateDomains: ["auth", "ux"],
        }),
        metadata: {
          repo: args.repo,
          scenario: "duplicate",
          target_issue: target.number,
        },
      };
    },
  },

  "replan-evaluate-fresh": {
    description: "Replan-evaluate on a fresh repo with several open issues",
    async build(args) {
      const { client, owner, repo } = await ghClientFor(args);
      const issues = await client.listIssues(owner, repo);
      return {
        prompt: buildReplanEvaluatePrompt({
          openIssues: issues.map((i) => ({
            number: i.number,
            title: i.title,
            body: i.body,
            labels: i.labels,
          })),
          currentPlanBody: null,
        }),
        metadata: {
          repo: args.repo,
          scenario: "fresh",
          issue_count: issues.length,
        },
      };
    },
  },

  "doc-coverage-clean": {
    description: "Doc coverage scan on a small set of well-documented files",
    async build(args) {
      return {
        prompt: buildDocCoveragePrompt({
          prNumber: 1,
          changedFiles: ["packages/core/agent.ts"],
        }),
        metadata: { scenario: "clean", repo: args.repo },
      };
    },
  },

  "doc-canonical-sync-significant": {
    description: "Canonical sync on a PR that adds a new CLI command",
    async build(args) {
      const prdContent = await fs.readFile(
        path.resolve(import.meta.dirname, "../docs/product.md"),
        "utf8",
      );
      return {
        prompt: buildDocCanonicalSyncPrompt({
          prNumber: 1,
          prTitle: "feat(cli): add `superfield doctor` command",
          prBody:
            "Adds a new `doctor` subcommand that diagnoses configuration issues.",
          changedFiles: ["packages/cli/commands/doctor.ts"],
          prdContent,
          readmeContent: "# Superfield\n",
        }),
        metadata: { scenario: "significant-new-command", repo: args.repo },
      };
    },
  },

  "blueprint-conformance-conformant": {
    description: "Blueprint conformance check expected to find zero violations",
    async build(args) {
      const issue = await fetchIssue(args);
      return {
        prompt: buildBlueprintConformancePrompt({
          issue,
          candidateDomains: ["arch"],
        }),
        metadata: {
          repo: args.repo,
          issue_number: issue.number,
          scenario: "conformant",
        },
      };
    },
  },

  "blueprint-conformance-violating": {
    description: "Blueprint conformance check expected to flag a violation",
    async build(args) {
      const issue = await fetchIssue(args);
      return {
        prompt: buildBlueprintConformancePrompt({
          issue,
          candidateDomains: ["arch"],
        }),
        metadata: {
          repo: args.repo,
          issue_number: issue.number,
          scenario: "violating",
        },
      };
    },
  },

  "blueprint-self-audit-conformant": {
    description: "Pre-PR self-audit on a conforming diff",
    async build(args) {
      const issue = await fetchIssue(args);
      return {
        prompt: buildPrePRSelfAuditPrompt({
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueBody: issue.body ?? "",
          candidateDomains: ["arch"],
          diffSummary: "- modified: packages/core/agent.ts",
        }),
        metadata: {
          repo: args.repo,
          issue_number: issue.number,
          scenario: "self-audit-conformant",
        },
      };
    },
  },

  "blueprint-self-audit-violating": {
    description: "Pre-PR self-audit on a non-conforming diff",
    async build(args) {
      const issue = await fetchIssue(args);
      return {
        prompt: buildPrePRSelfAuditPrompt({
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueBody: issue.body ?? "",
          candidateDomains: ["test"],
          diffSummary: "- added: packages/core/tests/unit/foo.test.ts",
        }),
        metadata: {
          repo: args.repo,
          issue_number: issue.number,
          scenario: "self-audit-violating",
        },
      };
    },
  },

  "feature-evaluate-exploratory": {
    description:
      "Feature-evaluate first (exploratory) pass — returns non-null candidateApproach",
    async build(args) {
      return {
        prompt: buildFeatureEvaluatePrompt({
          request: "Add a logout button to the navbar that clears the session",
          planBody: null,
          openIssueTitles: [],
          candidateDomains: ["auth", "ux"],
        }),
        metadata: { repo: args.repo, scenario: "exploratory-first-pass" },
      };
    },
  },

  "feature-evaluate-narrowed": {
    description:
      "Feature-narrow second pass — refines the exploratory candidate into a final IssueBody",
    async build(args) {
      return {
        prompt: buildFeatureNarrowPrompt({
          request: "Add a logout button to the navbar that clears the session",
          planBody: null,
          openIssueTitles: [],
          candidateDomains: ["auth", "ux"],
          candidateApproach:
            "Add a NavBar button that calls authService.signOut() and navigates to /login.",
        }),
        metadata: { repo: args.repo, scenario: "narrow-second-pass" },
      };
    },
  },

  "dev-loop-first-turn": {
    description:
      "Dev-loop first turn — narrow blueprint context (implementation + antipattern)",
    async build(args) {
      const issue = await fetchIssue(args);
      return {
        prompt: buildDevelopIssuePrompt({
          issue,
          role: "primary",
          worktreePath: "/tmp/worktree",
          branch: "issue-1",
          phaseName: "Phase 1",
        }),
        metadata: {
          repo: args.repo,
          issue_number: issue.number,
          scenario: "first-turn-narrow",
        },
      };
    },
  },

  "dev-loop-escalated": {
    description:
      "Dev-loop second turn after escalation — adds principles + threats",
    async build(args) {
      const issue = await fetchIssue(args);
      return {
        prompt: buildDevelopIssuePrompt({
          issue,
          role: "primary",
          worktreePath: "/tmp/worktree",
          branch: "issue-1",
          phaseName: "Phase 1",
          escalated: true,
        }),
        metadata: {
          repo: args.repo,
          issue_number: issue.number,
          scenario: "escalated-second-turn",
        },
      };
    },
  },

  "doc-consistency-clean": {
    description: "Doc consistency check across canonical and inline samples",
    async build(args) {
      const prd = await fs.readFile(
        path.resolve(import.meta.dirname, "../docs/product.md"),
        "utf8",
      );
      const agentTs = await fs.readFile(
        path.resolve(import.meta.dirname, "../packages/core/agent.ts"),
        "utf8",
      );
      return {
        prompt: buildDocConsistencyPrompt({
          canonicalSnippets: [
            { path: "docs/prd.md", content: prd.slice(0, 4000) },
          ],
          moduleSnippets: [],
          inlineSnippets: [
            {
              path: "packages/core/agent.ts",
              symbol: "(file)",
              content: agentTs.slice(0, 2000),
            },
          ],
        }),
        metadata: { scenario: "clean", repo: args.repo },
      };
    },
  },
};

async function fetchIssue(args: RecorderArgs) {
  const { client, owner, repo } = await ghClientFor(args);
  if (!args.issueNumber) {
    throw new Error("--issue <number> is required for this fixture");
  }
  return client.getIssue(owner, repo, args.issueNumber);
}

async function ghClientFor(args: RecorderArgs) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN env var is required");
  const repoSpec = args.repo ?? "dot-matrix-labs/superfield-ts";
  const [owner, repo] = repoSpec.split("/");
  if (!owner || !repo) throw new Error(`Invalid --repo: ${repoSpec}`);
  return { client: new GitHubClient(token), owner, repo };
}

function parseArgs(argv: string[]): RecorderArgs & { list: boolean } {
  const args: RecorderArgs & { list: boolean } = { task: "", list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--list") {
      args.list = true;
    } else if (a === "--repo") {
      args.repo = argv[++i];
    } else if (a === "--issue") {
      args.issueNumber = Number(argv[++i]);
    } else if (!args.task) {
      args.task = a;
    }
  }
  return args;
}

function printList(): void {
  console.log("Available fixture tasks:\n");
  for (const [name, recorder] of Object.entries(RECORDERS)) {
    console.log(`  ${name}`);
    console.log(`    ${recorder.description}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list || !args.task) {
    printList();
    if (!args.task) process.exit(args.list ? 0 : 1);
    return;
  }

  const recorder = RECORDERS[args.task];
  if (!recorder) {
    console.error(`Unknown fixture task: ${args.task}`);
    console.error(
      "Run `bun record-claude-fixtures --list` to see available tasks.",
    );
    process.exit(1);
  }

  console.log(`Recording fixture: ${args.task}`);
  console.log(`  ${recorder.description}\n`);

  const { prompt, metadata } = await recorder.build(args);

  console.log("Spawning real `claude` (this may take 30–60 seconds)...");
  const result = await spawnAgent({
    prompt,
    worktreePath: process.cwd(),
    maxTurns: 5,
  });

  const fixture = {
    sessionId: result.sessionId,
    output: result.output,
    isError: result.isError,
    costUsd: result.costUsd,
    _metadata: {
      captured_at: new Date().toISOString(),
      ...metadata,
    },
  };

  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  const outPath = path.join(FIXTURES_DIR, `${args.task}.json`);
  await fs.writeFile(outPath, JSON.stringify(fixture, null, 2) + "\n", "utf8");

  console.log(`✓ Wrote ${outPath}`);
  console.log(`  Cost: $${(result.costUsd ?? 0).toFixed(4)}`);
}

const entry = process.argv[1]?.split("/").pop();
if (entry && import.meta.url.endsWith(entry)) {
  await main();
}
