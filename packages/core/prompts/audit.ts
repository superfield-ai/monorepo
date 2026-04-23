import { joinSections, bullet } from "./fragments/index.ts";
import type { AuditCapability } from "../audit/capabilities.ts";

export interface AuditPromptContext {
  capability: AuditCapability;
}

export function buildAuditCapabilityPrompt(ctx: AuditPromptContext): string {
  const { capability } = ctx;

  return joinSections(
    `## Task: capability-audit

You are auditing a codebase to determine whether it implements the following capability:

**${capability.name}**

${capability.description}

Your working directory is the root of the application repository. Use your tools (Read, Bash, Grep, Glob) to explore as needed. Be thorough — a missing feature may be implemented under an unexpected name or path.`,

    `## What to look for

${bullet(capability.lookFor)}

Search broadly before concluding something is absent:
- Check \`package.json\` and lock files for relevant dependencies
- Check source directories: \`src/\`, \`app/\`, \`lib/\`, \`server/\`, \`client/\`, \`public/\`
- Check configuration files and schema definitions
- Check entry points and middleware registration`,

    `## Output contract

When you have finished your investigation, emit exactly one JSON object — no surrounding prose:

\`\`\`json
{
  "capabilityId": "${capability.id}",
  "present": true,
  "conformant": false,
  "gaps": [
    "Specific missing piece 1",
    "Specific missing piece 2"
  ],
  "evidence": [
    "src/path/to/relevant/file.ts",
    "package.json dependency: relevant-package"
  ],
  "summary": "2–3 sentence verdict: what exists and what is missing."
}
\`\`\`

Field rules:
- \`present\`: \`true\` if the feature exists in any form, even incomplete
- \`conformant\`: \`true\` only if the implementation is complete per the description above
- \`gaps\`: specific, actionable items — empty array when \`conformant\` is \`true\`
- \`evidence\`: file paths or dependency names you found; empty array if nothing found
- \`summary\`: 2–3 sentences describing what you found and what is missing
- Emit JSON only — no explanation outside the JSON block`,
  );
}
