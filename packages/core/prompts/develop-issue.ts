import type { Issue } from "@superfield/github";
import type { AgentRole } from "../sessions.ts";
import type { BlueprintViolation } from "../steps/blueprint-conformance.ts";
import { pickCandidateDomains } from "../blueprint.ts";
import {
  projectContextFragment,
  commitStandardsFragment,
  worktreeIsolationFragment,
  roleFragment,
  tddOutsideInFragment,
  blueprintReferenceFragment,
  buildBlueprintContextFragment,
  joinSections,
} from "./fragments/index.ts";

export interface DevelopIssueContext {
  issue: Issue;
  role: AgentRole;
  worktreePath: string;
  branch: string;
  phaseName: string;
  /**
   * When true, layer an expanded blueprint context fragment
   * (domain-filtered `principle` + `threat` rules) on top of the narrow
   * first-turn fragment. Set by the dev-loop runner after an agent
   * returns `needsBlueprintEscalation: true` on a previous turn. One-shot
   * latch — stays true for the remainder of the issue (#78).
   */
  escalated?: boolean;
  /**
   * Violations carried over from a non-conformant pre-PR self-audit (#81).
   * When present, the prompt renders a "Pending blueprint remediation"
   * section instructing the agent to address each item before re-running
   * the audit. Cleared by the dev-loop once the audit returns conformant.
   */
  remediationViolations?: BlueprintViolation[];
}

/**
 * Prompt for a feature/development agent. Used by both primary and
 * speculative slots — the role fragment varies the stop conditions and
 * PR-opening behavior.
 *
 * Replaces superfield-agents `develop-issue` SKILL.md, restructured around
 * Superfield's 7-stage dev-loop lifecycle and the unified IssueBody schema.
 */
export function buildDevelopIssuePrompt(ctx: DevelopIssueContext): string {
  const domains = pickCandidateDomains({
    title: ctx.issue.title,
    body: ctx.issue.body ?? null,
    labels: ctx.issue.labels ?? [],
  });
  const narrowContext = buildBlueprintContextFragment({
    domains,
    ruleTypes: ["implementation", "antipattern"],
    budgetBytes: 4096,
  });
  const expandedContext = ctx.escalated
    ? buildBlueprintContextFragment({
        domains,
        ruleTypes: ["principle", "threat"],
        budgetBytes: 4096,
        header: "## Blueprint rules (expanded context — escalation)",
      })
    : "";
  return joinSections(
    projectContextFragment(),
    `## Assignment

- Issue: #${ctx.issue.number} — ${ctx.issue.title}
- Phase: ${ctx.phaseName}
- Branch: ${ctx.branch}
- URL: ${ctx.issue.html_url}`,
    `## Issue body

${ctx.issue.body ?? "(no body)"}`,
    worktreeIsolationFragment(ctx.worktreePath),
    roleFragment(ctx.role),
    tddOutsideInFragment(),
    narrowContext,
    expandedContext,
    renderRemediationSection(ctx.remediationViolations),
    blueprintReferenceFragment(),
    commitStandardsFragment(),
    `## Begin

\`cd\` into your worktree and start by re-reading the issue. Then write the \
outermost failing test.`,
  );
}

function renderRemediationSection(
  violations: BlueprintViolation[] | undefined,
): string {
  if (!violations || violations.length === 0) return "";
  const lines: string[] = ["## Pending blueprint remediation", ""];
  lines.push(
    "Your previous turn produced a diff that failed the pre-PR blueprint \
self-audit. Address each violation below before re-running the audit:",
  );
  lines.push("");
  for (const v of violations) {
    lines.push(
      `- **${v.rule_id}** \`${v.rule_name}\` (${v.rule_type}, ${v.domain}): ${v.concern}`,
    );
  }
  return lines.join("\n");
}
