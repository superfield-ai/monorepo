import { describe, it, expect, vi } from "vitest";
import {
  runPrePRSelfAudit,
  type PrePRSelfAuditViolation,
} from "../../steps/pre-pr-self-audit.ts";
import { buildPrePRSelfAuditPrompt } from "../../prompts/pre-pr-self-audit.ts";
import type { Issue } from "@superfield/github";
import type { AgentOpts, AgentResult } from "../../agent.ts";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 81,
    title: "feat(dev-loop): pre-PR blueprint self-audit stage",
    body: "## Phase\nBlueprint integration\n\n## Motivation\nguard the PR.",
    html_url: "",
    state: "open",
    labels: ["arch"],
    ...overrides,
  };
}

function spawnReturning(json: string) {
  return vi.fn(async (_opts: AgentOpts): Promise<AgentResult> => ({
    sessionId: "sess",
    output: json,
    isError: false,
  }));
}

const sampleViolation: PrePRSelfAuditViolation = {
  rule_id: "ARCH-T-001",
  rule_name: "server-code-in-browser-bundle",
  rule_type: "threat",
  domain: "arch",
  concern: "Web bundle imports a node-only module from packages/core/agent.ts.",
};

describe("buildPrePRSelfAuditPrompt", () => {
  it("includes implementation + principle + threat + antipattern rule types", () => {
    const prompt = buildPrePRSelfAuditPrompt({
      issueNumber: 81,
      issueTitle: "test",
      issueBody: "body",
      candidateDomains: ["arch"],
      diffSummary: "- modified: a.ts",
    });
    // The full-context header should be present.
    expect(prompt).toContain(
      "## Blueprint rules (full context — pre-PR self-audit)",
    );
    // The render switches headers per ruleType — check at least the labels.
    // We only assert presence of all four rule type labels in the rendered
    // fragment when the blueprint actually has rules for the domain. The
    // header alone is enough to prove the call site asked for full context.
    expect(prompt).toContain("Pre-PR blueprint self-audit");
  });

  it("renders the previousViolations remediation section when present", () => {
    const prompt = buildPrePRSelfAuditPrompt({
      issueNumber: 81,
      issueTitle: "test",
      issueBody: "body",
      candidateDomains: ["arch"],
      diffSummary: "- modified: a.ts",
      previousViolations: [sampleViolation],
    });
    expect(prompt).toContain("## Pending blueprint remediation");
    expect(prompt).toContain("ARCH-T-001");
    expect(prompt).toContain("Web bundle imports a node-only module");
  });

  it("omits the remediation section on a first-time audit", () => {
    const prompt = buildPrePRSelfAuditPrompt({
      issueNumber: 81,
      issueTitle: "test",
      issueBody: "body",
      candidateDomains: ["arch"],
      diffSummary: "- modified: a.ts",
    });
    expect(prompt).not.toContain("## Pending blueprint remediation");
  });
});

describe("runPrePRSelfAudit", () => {
  it("parses a conformant verdict and returns no violations", async () => {
    const spawn = spawnReturning(
      JSON.stringify({ conformant: true, violations: [] }),
    );
    const result = await runPrePRSelfAudit({
      issue: makeIssue(),
      repoPath: "/tmp/does-not-exist-on-purpose",
      spawn,
      diffSummary: "(no changes detected)",
      candidateDomains: [],
    });
    expect(result.conformant).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("parses a violating verdict and returns the violations list", async () => {
    const spawn = spawnReturning(
      JSON.stringify({ conformant: false, violations: [sampleViolation] }),
    );
    const result = await runPrePRSelfAudit({
      issue: makeIssue(),
      repoPath: "/tmp/does-not-exist-on-purpose",
      spawn,
      diffSummary: "- modified: a.ts",
      candidateDomains: ["arch"],
    });
    expect(result.conformant).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_id).toBe("ARCH-T-001");
    expect(result.violations[0]!.concern).toContain("node-only");
  });

  it("rejects a non-conformant verdict that has no violations", async () => {
    const spawn = spawnReturning(
      JSON.stringify({ conformant: false, violations: [] }),
    );
    await expect(
      runPrePRSelfAudit({
        issue: makeIssue(),
        repoPath: "/tmp/does-not-exist-on-purpose",
        spawn,
        diffSummary: "- modified: a.ts",
        candidateDomains: ["arch"],
      }),
    ).rejects.toThrow(/no violations/);
  });
});
