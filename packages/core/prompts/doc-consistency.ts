import { joinSections } from './fragments/index.ts';

export interface DocConsistencyContext {
  /** Sample of canonical doc snippets keyed by source path. */
  canonicalSnippets: Array<{ path: string; content: string }>;
  /** Sample of module/package READMEs and doc comments. */
  moduleSnippets: Array<{ path: string; content: string }>;
  /** Sample of inline doc comments from source. */
  inlineSnippets: Array<{ path: string; symbol: string; content: string }>;
}

/**
 * Prompt for the documentation loop's consistency check step. Compares the
 * three levels of the documentation fractal (canonical → module → inline)
 * for contradictions and resolves them by treating the code as ground truth.
 */
export function buildDocConsistencyPrompt(ctx: DocConsistencyContext): string {
  const fmt = (label: string, items: Array<{ path: string; content: string }>) =>
    `### ${label}\n\n` +
    items.map((s) => `**${s.path}**\n\n${s.content}`).join('\n\n---\n\n');

  return joinSections(
    `## Task: doc-consistency

You are checking the documentation fractal for cross-level inconsistencies. \
Documentation is maintained at three levels:

1. **Canonical** — PRD, architecture docs, top-level README
2. **Module** — package READMEs, public API doc comments
3. **Inline** — function and type doc comments in source files

A change at any level can create inconsistencies at the others. Your job is \
to detect and resolve them. Treat the code (inline level) as ground truth: \
if module or canonical docs contradict the inline reality, the inline \
description wins.`,
    fmt('Canonical snippets', ctx.canonicalSnippets),
    fmt('Module snippets', ctx.moduleSnippets),
    `### Inline snippets

${ctx.inlineSnippets.map((s) => `**${s.path}** — \`${s.symbol}\`\n\n${s.content}`).join('\n\n---\n\n')}`,
    `## What you check

For each canonical or module snippet, ask:

- Does it describe a function/class/type that still exists?
- Does the description still match what the inline doc says?
- Are flags, options, return values, or behaviors still accurate?

## Output contract

Emit exactly one JSON object:

\`\`\`json
{
  "inconsistencies": [
    {
      "level": "canonical",
      "path": "docs/prd.md",
      "section": "## Configuration",
      "concern": "PRD says config lives at ~/.foo but code says ~/.superfield",
      "ground_truth_source": "packages/core/config.ts",
      "fix_text_old": "~/.foo",
      "fix_text_new": "~/.superfield"
    }
  ]
}
\`\`\`

If no inconsistencies are found, emit \`"inconsistencies": []\`.

Emit JSON only — no surrounding prose.`,
  );
}
