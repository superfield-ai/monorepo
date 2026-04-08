import { joinSections } from './fragments/index.ts';

export interface DocCanonicalSyncContext {
  prNumber: number;
  prTitle: string;
  prBody: string;
  changedFiles: string[];
  /** Current PRD content. */
  prdContent: string;
  /** Current README content. */
  readmeContent: string;
}

/**
 * Prompt for the documentation loop's canonical sync step. If the merged PR
 * introduced a significant feature (new command, new public API, changed
 * behavior), updates the relevant canonical documents to match.
 */
export function buildDocCanonicalSyncPrompt(ctx: DocCanonicalSyncContext): string {
  return joinSections(
    `## Task: doc-canonical-sync

PR #${ctx.prNumber} just merged to \`main\`. Determine whether it introduced \
a significant feature that requires updating the PRD or README, and if so, \
emit the patches to apply.

### Merged PR

Title: ${ctx.prTitle}

Body:
${ctx.prBody}

### Files changed

${ctx.changedFiles.map((f) => `- ${f}`).join('\n')}

### Current PRD (\`docs/prd.md\`)

${ctx.prdContent}

### Current README

${ctx.readmeContent}`,
    `## What counts as significant

Update the canonical docs only if the PR:

- Adds a new CLI command or subcommand
- Adds a new public API surface (exported function, class, type) that other \
packages can consume
- Changes the behavior of an existing command in a way that contradicts the \
PRD's current description
- Adds or removes a Roadmap-phase deliverable
- Adds a new loop or stage to \`start\`
- Adds a new external dependency listed in the Libraries section

Bug fixes, refactors, internal cleanups, test additions, and minor changes \
do NOT require canonical doc updates. If the change is not significant, emit \
empty patches.

## Output contract

Emit exactly one JSON object:

\`\`\`json
{
  "significant": true,
  "rationale": "1 sentence explaining why this is canonically significant",
  "prd_patches": [
    {
      "section": "## Roadmap",
      "old_text": "...",
      "new_text": "..."
    }
  ],
  "readme_patches": []
}
\`\`\`

Patches must be exact text replacements suitable for non-fuzzy string match. \
\`old_text\` must appear verbatim in the current document. If the change is \
not significant, set \`"significant": false\` and emit empty arrays.

Emit JSON only — no surrounding prose.`,
  );
}
