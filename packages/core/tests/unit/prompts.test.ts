import { describe, it, expect } from "vitest";
import {
  buildDevelopIssuePrompt,
  buildDevScoutPrompt,
  buildCIFailurePrompt,
  buildFeatureEvaluatePrompt,
  buildReplanEvaluatePrompt,
  buildIssueAuditPrompt,
  buildBlueprintConformancePrompt,
  buildDocCoveragePrompt,
  buildDocCanonicalSyncPrompt,
  buildDocConsistencyPrompt,
} from "../../prompts/index.ts";
import type { Issue } from "@superfield/github";

const issue: Issue = {
  number: 42,
  title: "feat: example feature",
  body: "## Phase\nIdentity\n\n## Motivation\nBecause.\n\n## Features\n- [ ] Build it\n\n## Test Plan\n- [ ] Verify it",
  html_url: "https://github.com/o/r/issues/42",
  state: "open",
  labels: ["feature"],
};

describe("prompt builders — structural invariants", () => {
  describe("buildDevelopIssuePrompt", () => {
    it("primary variant includes role and lifecycle stages", () => {
      const out = buildDevelopIssuePrompt({
        issue,
        role: "primary",
        worktreePath: "/tmp/wt",
        branch: "feat/42",
        phaseName: "Identity",
      });
      expect(out).toContain("Role: PRIMARY");
      expect(out).toContain("CI pass");
      expect(out).toContain("Merge");
      expect(out).toContain("TDD outside-in");
      expect(out).toContain("/tmp/wt");
      expect(out).toContain("#42");
    });

    it("speculative variant excludes PR-opening duty", () => {
      const out = buildDevelopIssuePrompt({
        issue,
        role: "speculative",
        worktreePath: "/tmp/wt",
        branch: "feat/42",
        phaseName: "Identity",
      });
      expect(out).toContain("Role: SPECULATIVE");
      expect(out).toContain("Do NOT");
      expect(out).toContain("Open a pull request");
    });
  });

  describe("buildDevScoutPrompt", () => {
    it("contains it.todo and merge qualification", () => {
      const out = buildDevScoutPrompt({
        scoutIssue: issue,
        worktreePath: "/tmp/wt",
        branch: "chore/scout",
        phaseName: "Identity",
        phaseGoal: "Build the auth seams",
        featureIssues: [{ ...issue, number: 50, title: "feat: child" }],
      });
      expect(out).toContain("it.todo()");
      expect(out).toContain("Stubs only");
      expect(out).toContain("#50");
      expect(out).toContain("Build the auth seams");
    });
  });

  describe("buildCIFailurePrompt", () => {
    it("contains check name, sha, url, primary role", () => {
      const out = buildCIFailurePrompt({
        issue,
        checkName: "test:unit",
        checkRunUrl: "https://github.com/o/r/runs/1",
        sha: "abc1234",
        worktreePath: "/tmp/wt",
        branch: "fix/ci",
      });
      expect(out).toContain("test:unit");
      expect(out).toContain("abc1234");
      expect(out).toContain("https://github.com/o/r/runs/1");
      expect(out).toContain("primary agent");
    });
  });

  describe("buildFeatureEvaluatePrompt", () => {
    it("embeds the request and IssueBody output contract", () => {
      const out = buildFeatureEvaluatePrompt({
        request: "Add a logout button to the navbar",
        planBody: "## Phase: P\n",
        openIssueTitles: [{ number: 1, title: "feat: existing" }],
      });
      expect(out).toContain("Add a logout button to the navbar");
      expect(out).toContain('"features"');
      expect(out).toContain('"test_plan"');
      expect(out).toContain("feat: existing");
      expect(out).toContain("duplicate_of");
      expect(out).toContain("substantially the same as an existing open issue");
      expect(out).not.toContain('"acceptance_criteria"');
      expect(out).not.toContain('"scope"');
    });
  });

  describe("buildReplanEvaluatePrompt", () => {
    it("includes ordered_issues contract", () => {
      const out = buildReplanEvaluatePrompt({
        openIssues: [
          { number: 10, title: "feat: A", body: "a body", labels: ["feature"] },
        ],
        currentPlanBody: null,
      });
      expect(out).toContain('"ordered_issues"');
      expect(out).toContain('"phases"');
      expect(out).toContain("feat: A");
    });
  });

  describe("buildIssueAuditPrompt", () => {
    it("lists required and forbidden sections", () => {
      const out = buildIssueAuditPrompt({ issue });
      expect(out).toContain("## Phase");
      expect(out).toContain("## Features");
      expect(out).toContain("## Test Plan");
      expect(out).toContain("## Deliverables");
      expect(out).toContain("## Acceptance Criteria");
      expect(out).toContain('"conformant"');
    });
  });

  describe("buildBlueprintConformancePrompt", () => {
    it("lists candidate domains and is advisory", () => {
      const out = buildBlueprintConformancePrompt({
        issue,
        candidateDomains: ["arch", "auth"],
      });
      expect(out).toContain("blueprint/rules/blueprints/arch.yaml");
      expect(out).toContain("blueprint/rules/blueprints/auth.yaml");
      expect(out).toContain("advisory");
      expect(out).toContain('"violations"');
    });
  });

  describe("buildDocCoveragePrompt", () => {
    it("lists changed files and exported-symbol rules", () => {
      const out = buildDocCoveragePrompt({
        prNumber: 99,
        changedFiles: ["packages/core/foo.ts", "packages/cli/bar.ts"],
      });
      expect(out).toContain("PR #99");
      expect(out).toContain("packages/core/foo.ts");
      expect(out).toContain("packages/cli/bar.ts");
      expect(out).toContain("export");
      expect(out).toContain('"missing_docs"');
    });
  });

  describe("buildDocCanonicalSyncPrompt", () => {
    it("embeds PR title, body, current PRD and README", () => {
      const out = buildDocCanonicalSyncPrompt({
        prNumber: 100,
        prTitle: "feat: new command",
        prBody: "Adds frobnicate command",
        changedFiles: ["packages/cli/commands/frobnicate.ts"],
        prdContent: "# PRD\n## Commands\n",
        readmeContent: "# README\n",
      });
      expect(out).toContain("PR #100");
      expect(out).toContain("feat: new command");
      expect(out).toContain("Adds frobnicate command");
      expect(out).toContain('"significant"');
      expect(out).toContain('"prd_patches"');
    });
  });

  describe("buildDocConsistencyPrompt", () => {
    it("embeds three-level fractal snippets", () => {
      const out = buildDocConsistencyPrompt({
        canonicalSnippets: [{ path: "docs/prd.md", content: "# PRD" }],
        moduleSnippets: [
          { path: "packages/core/README.md", content: "# core" },
        ],
        inlineSnippets: [
          {
            path: "packages/core/foo.ts",
            symbol: "spawnAgent",
            content: "/** doc */",
          },
        ],
      });
      expect(out).toContain("Canonical snippets");
      expect(out).toContain("Module snippets");
      expect(out).toContain("Inline snippets");
      expect(out).toContain("docs/prd.md");
      expect(out).toContain("spawnAgent");
      expect(out).toContain('"inconsistencies"');
    });
  });
});

describe("prompt builders — snapshots", () => {
  it("buildDevelopIssuePrompt primary matches snapshot", () => {
    expect(
      buildDevelopIssuePrompt({
        issue,
        role: "primary",
        worktreePath: "/tmp/wt",
        branch: "feat/42",
        phaseName: "Identity",
      }),
    ).toMatchSnapshot();
  });

  it("buildDevelopIssuePrompt speculative matches snapshot", () => {
    expect(
      buildDevelopIssuePrompt({
        issue,
        role: "speculative",
        worktreePath: "/tmp/wt",
        branch: "feat/42",
        phaseName: "Identity",
      }),
    ).toMatchSnapshot();
  });

  it("buildDevScoutPrompt matches snapshot", () => {
    expect(
      buildDevScoutPrompt({
        scoutIssue: issue,
        worktreePath: "/tmp/wt",
        branch: "chore/scout",
        phaseName: "Identity",
        phaseGoal: "Build the auth seams",
        featureIssues: [{ ...issue, number: 50, title: "feat: child" }],
      }),
    ).toMatchSnapshot();
  });

  it("buildCIFailurePrompt matches snapshot", () => {
    expect(
      buildCIFailurePrompt({
        issue,
        checkName: "test:unit",
        checkRunUrl: "https://github.com/o/r/runs/1",
        sha: "abc1234",
        worktreePath: "/tmp/wt",
        branch: "fix/ci",
      }),
    ).toMatchSnapshot();
  });

  it("buildFeatureEvaluatePrompt matches snapshot", () => {
    expect(
      buildFeatureEvaluatePrompt({
        request: "Add a logout button to the navbar",
        planBody: "## Phase: P\n",
        openIssueTitles: [{ number: 1, title: "feat: existing" }],
      }),
    ).toMatchSnapshot();
  });

  it("buildReplanEvaluatePrompt matches snapshot", () => {
    expect(
      buildReplanEvaluatePrompt({
        openIssues: [
          { number: 10, title: "feat: A", body: "a body", labels: ["feature"] },
        ],
        currentPlanBody: null,
      }),
    ).toMatchSnapshot();
  });

  it("buildIssueAuditPrompt matches snapshot", () => {
    expect(buildIssueAuditPrompt({ issue })).toMatchSnapshot();
  });

  it("buildBlueprintConformancePrompt matches snapshot", () => {
    expect(
      buildBlueprintConformancePrompt({
        issue,
        candidateDomains: ["arch", "auth"],
      }),
    ).toMatchSnapshot();
  });

  it("buildDocCoveragePrompt matches snapshot", () => {
    expect(
      buildDocCoveragePrompt({
        prNumber: 99,
        changedFiles: ["packages/core/foo.ts", "packages/cli/bar.ts"],
      }),
    ).toMatchSnapshot();
  });

  it("buildDocCanonicalSyncPrompt matches snapshot", () => {
    expect(
      buildDocCanonicalSyncPrompt({
        prNumber: 100,
        prTitle: "feat: new command",
        prBody: "Adds frobnicate command",
        changedFiles: ["packages/cli/commands/frobnicate.ts"],
        prdContent: "# PRD\n## Commands\n",
        readmeContent: "# README\n",
      }),
    ).toMatchSnapshot();
  });

  it("buildDocConsistencyPrompt matches snapshot", () => {
    expect(
      buildDocConsistencyPrompt({
        canonicalSnippets: [{ path: "docs/prd.md", content: "# PRD" }],
        moduleSnippets: [
          { path: "packages/core/README.md", content: "# core" },
        ],
        inlineSnippets: [
          {
            path: "packages/core/foo.ts",
            symbol: "spawnAgent",
            content: "/** doc */",
          },
        ],
      }),
    ).toMatchSnapshot();
  });
});

describe("prompt builders — pure functions", () => {
  it("buildDevelopIssuePrompt is deterministic for the same input", () => {
    const ctx = {
      issue,
      role: "primary" as const,
      worktreePath: "/tmp/wt",
      branch: "feat/42",
      phaseName: "Identity",
    };
    expect(buildDevelopIssuePrompt(ctx)).toBe(buildDevelopIssuePrompt(ctx));
  });

  it("buildIssueAuditPrompt is deterministic", () => {
    expect(buildIssueAuditPrompt({ issue })).toBe(
      buildIssueAuditPrompt({ issue }),
    );
  });
});
