import { joinSections } from "./fragments/index.ts";

export interface DocCoverageContext {
  /** Files changed in the PR that just merged. */
  changedFiles: string[];
  /** PR number for context. */
  prNumber: number;
}

/**
 * Prompt for the documentation loop's coverage scan step. Inspects source
 * files changed in a merged PR and flags exported symbols that lack doc
 * comments.
 */
export function buildDocCoveragePrompt(ctx: DocCoverageContext): string {
  return joinSections(
    `## Task: doc-coverage

PR #${ctx.prNumber} just merged to \`main\`. Scan the changed source files \
for exported symbols (functions, classes, types, interfaces, constants) that \
lack a doc comment.

### Files changed

${ctx.changedFiles.map((f) => `- ${f}`).join("\n")}`,
    `## What you check

For each \`.ts\` file in the list above:

1. Read the file.
2. Find every \`export\` declaration: \`export function\`, \`export class\`, \
\`export interface\`, \`export type\`, \`export const\`, \`export enum\`.
3. Check whether the line immediately above each export is a JSDoc comment \
(\`/** ... */\`) or a single-line comment block describing the symbol.
4. Flag any export that lacks a doc comment.

Skip:

- Re-exports from \`index.ts\` files (\`export { Foo } from './foo.ts'\`)
- Symbols starting with \`_\` (intentionally internal)
- Files in \`tests/\` directories

## Output contract

Emit exactly one JSON object:

\`\`\`json
{
  "missing_docs": [
    {
      "file": "packages/core/agent.ts",
      "symbol": "spawnAgent",
      "kind": "function",
      "line": 42
    }
  ]
}
\`\`\`

If everything is documented, emit \`"missing_docs": []\`.

Emit JSON only — no surrounding prose.`,
  );
}
