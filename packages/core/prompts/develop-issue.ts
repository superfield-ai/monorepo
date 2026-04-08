import type { Issue } from "@superfield/github";
import type { AgentRole } from "../sessions.ts";
import {
  projectContextFragment,
  commitStandardsFragment,
  worktreeIsolationFragment,
  roleFragment,
  tddOutsideInFragment,
  blueprintReferenceFragment,
  joinSections,
} from "./fragments/index.ts";

export interface DevelopIssueContext {
  issue: Issue;
  role: AgentRole;
  worktreePath: string;
  branch: string;
  phaseName: string;
}

/**
 * Prompt for a feature/development agent. Used by both primary and
 * speculative slots — the role fragment varies the stop conditions and
 * PR-opening behavior.
 *
 * Replaces calypso-agents `develop-issue` SKILL.md, restructured around
 * Superfield's 7-stage dev-loop lifecycle and the unified IssueBody schema.
 */
export function buildDevelopIssuePrompt(ctx: DevelopIssueContext): string {
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
    blueprintReferenceFragment(),
    commitStandardsFragment(),
    `## Begin

\`cd\` into your worktree and start by re-reading the issue. Then write the \
outermost failing test.`,
  );
}
