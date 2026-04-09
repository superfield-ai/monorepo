import {
  projectContextFragment,
  buildBlueprintContextFragment,
  joinSections,
} from "./fragments/index.ts";
import type { BlueprintViolation } from "../steps/blueprint-conformance.ts";

/**
 * Build the pre-PR blueprint self-audit prompt sent to the agent after the
 * "checklist complete" stage and before opening a PR (issue #81).
 *
 * The agent is asked to read its own diff against the full blueprint context
 * for the candidate domains (implementation + principles + threats +
 * antipatterns) and emit a structured verdict the dev-loop can parse.
 *
 * On a `conformant: false` verdict, dev-loop loops back to develop with the
 * verdict's violations as explicit remediation instructions. The remediation
 * round is capped at 3 passes per issue.
 */
export interface PrePRSelfAuditPromptContext {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  candidateDomains: string[];
  diffSummary: string;
  /**
   * Violations carried over from a prior remediation round. When present, the
   * prompt includes a "Pending blueprint remediation" section quoting each
   * concern verbatim so the agent can address them explicitly.
   */
  previousViolations?: BlueprintViolation[];
}

export function buildPrePRSelfAuditPrompt(
  ctx: PrePRSelfAuditPromptContext,
): string {
  const blueprintContext = buildBlueprintContextFragment({
    domains: ctx.candidateDomains,
    ruleTypes: ["implementation", "principle", "threat", "antipattern"],
    budgetBytes: 8192,
    header: "## Blueprint rules (full context — pre-PR self-audit)",
  });

  const remediation =
    ctx.previousViolations && ctx.previousViolations.length > 0
      ? renderRemediation(ctx.previousViolations)
      : "";

  return joinSections(
    projectContextFragment(),
    `## Pre-PR blueprint self-audit — issue #${ctx.issueNumber}

You have just finished implementing this issue. Before the PR opens, audit \
your own diff against the blueprint rules below.`,
    `## Issue #${ctx.issueNumber} — ${ctx.issueTitle}

${ctx.issueBody || "(no body)"}`,
    `## Diff summary

${ctx.diffSummary || "(no changes detected)"}`,
    blueprintContext,
    remediation,
    `## Instructions

Audit your own diff against the blueprint rules above. A violation is a \
clear, specific conflict between your diff and a rule — not an absence of \
evidence and not a hypothetical concern. If your diff does not touch a rule's \
subject area, that rule is not violated.

${
  ctx.previousViolations && ctx.previousViolations.length > 0
    ? 'You are in a remediation round. Address each item in the "Pending blueprint remediation" section above explicitly — either fix the diff or, if the prior verdict was wrong, explain why in the verdict comment.\n\n'
    : ""
}\
Emit your verdict as a single JSON object with this exact shape:

\`\`\`json
{
  "conformant": true,
  "violations": []
}
\`\`\`

or, if you found violations:

\`\`\`json
{
  "conformant": false,
  "violations": [
    {
      "rule_id": "ARCH-T-001",
      "rule_name": "server-code-in-browser-bundle",
      "rule_type": "threat",
      "domain": "arch",
      "concern": "<one-sentence concrete description>"
    }
  ]
}
\`\`\`

Emit nothing but the JSON object.`,
  );
}

function renderRemediation(violations: BlueprintViolation[]): string {
  const lines: string[] = ["## Pending blueprint remediation", ""];
  lines.push(
    "A previous self-audit round flagged the following blueprint violations \
on your diff. Resolve each one before re-emitting a verdict:",
  );
  lines.push("");
  for (const v of violations) {
    lines.push(
      `- **${v.rule_id}** \`${v.rule_name}\` (${v.rule_type}, ${v.domain}): ${v.concern}`,
    );
  }
  return lines.join("\n");
}
