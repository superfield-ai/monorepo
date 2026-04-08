/**
 * Commit and version-control standards every agent must follow.
 */
export function commitStandardsFragment(): string {
  return `\
## Commit standards

- Use conventional commit prefixes: \`feat\`, \`fix\`, \`refactor\`, \`test\`, \
\`docs\`, \`chore\`, \`security\`.
- Stage files explicitly by name. Never use \`git add .\` or \`git add -A\`.
- Never use \`--no-verify\` to bypass pre-commit hooks. If a hook fails, fix \
the underlying issue.
- Reference the issue number in the commit body: \`Refs #N\` for in-progress, \
\`Closes #N\` only on the final commit that completes the work.
- Cite blueprint rule IDs in commit bodies when the change implements or \
mitigates a specific rule.`;
}
