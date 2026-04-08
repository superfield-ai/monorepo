/**
 * Shared project-context fragment used by every agent prompt.
 *
 * Tells the agent what Superfield is, where the canonical references live,
 * and what the forge-as-control-plane expectations are.
 */
export function projectContextFragment(): string {
  return `\
## Project: Superfield

Superfield is a GitOps AI orchestrator. The forge (GitHub) is the single source of \
truth for all orchestration state — issues are the task queue, the Plan tracking \
issue holds ordered work, PRs are change proposals, and merge to \`main\` means \
done. There is no local state aside from credentials.

### Canonical references

- Product requirements: \`docs/prd.md\` in this repository
- Design rules graph: \`blueprint/rules/graph.yaml\` (the Superfield Blueprint)
- Per-domain blueprint rules: \`blueprint/rules/blueprints/<domain>.yaml\`
- TypeScript implementation rules: \`blueprint/rules/implementations/ts/\`

When in doubt about an architectural or design decision, consult the blueprint \
rule that applies and cite its rule ID (e.g. \`ARCH-P-001\`) in commit messages \
and PR bodies.`;
}
