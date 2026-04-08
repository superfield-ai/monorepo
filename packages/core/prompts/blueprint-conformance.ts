import type { Issue } from '@superfield/github';
import { blueprintReferenceFragment, joinSections } from './fragments/index.ts';

export interface BlueprintConformanceContext {
  issue: Issue;
  /** Domain blueprints likely relevant to this issue. Pre-filtered by the orchestrator. */
  candidateDomains: string[];
}

/**
 * Prompt for the planning loop's blueprint conformance step. Evaluates one
 * issue against active rules in relevant blueprint domains and emits a list
 * of advisory violations. Does not block — just informs the agent that will
 * pick up the issue.
 */
export function buildBlueprintConformancePrompt(ctx: BlueprintConformanceContext): string {
  return joinSections(
    `## Task: blueprint-conformance

You are checking one GitHub issue against the Superfield Blueprint for \
conformance violations. This check is **advisory** — it does not block the \
issue from being worked. Its purpose is to surface concerns early so the \
agent picking up the issue knows what to watch out for.

### Issue #${ctx.issue.number} — ${ctx.issue.title}

${ctx.issue.body ?? '(no body)'}

### Candidate blueprint domains

${ctx.candidateDomains.map((d) => `- \`blueprint/rules/blueprints/${d}.yaml\``).join('\n')}`,
    blueprintReferenceFragment(),
    `## What you do

1. Read each candidate domain blueprint above.
2. For each rule whose \`type\` is \`threat\`, \`principle\`, or \
\`antipattern\`, evaluate whether the issue's proposed scope, motivation, or \
features could violate it.
3. Skip \`design_pattern\` and \`architecture\` rules — those are \
prescriptive guidance, not violations.
4. Skip rules where \`deprecated: true\`.

## Output contract

Emit exactly one JSON object:

\`\`\`json
{
  "issue_number": ${ctx.issue.number},
  "violations": [
    {
      "rule_id": "ARCH-T-001",
      "rule_name": "server-code-in-browser-bundle",
      "rule_type": "threat",
      "domain": "arch",
      "concern": "1–2 sentences explaining what in the issue conflicts with this rule"
    }
  ]
}
\`\`\`

If no violations are found, emit \`"violations": []\`.

## Rules

- Cite only real rule IDs that exist in the blueprint files. Do not invent.
- Be conservative: only flag rules where there is a clear, articulable concern.
- Emit JSON only — no surrounding prose.`,
  );
}
