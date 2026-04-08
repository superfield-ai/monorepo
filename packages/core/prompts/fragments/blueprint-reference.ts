/**
 * Tells the agent how to consult the bundled Superfield Blueprint when
 * making design decisions.
 */
export function blueprintReferenceFragment(): string {
  return `\
## Consulting the Blueprint

The Superfield Blueprint at \`blueprint/rules/graph.yaml\` is the authoritative \
source for architecture, security, design patterns, and antipatterns. Before \
introducing a new public API, a new dependency, a new module boundary, or a \
new pattern, search the relevant domain blueprint:

- Architecture: \`blueprint/rules/blueprints/arch.yaml\`
- Auth & sessions: \`blueprint/rules/blueprints/auth.yaml\`
- Data layer: \`blueprint/rules/blueprints/data.yaml\`
- Testing: \`blueprint/rules/blueprints/test.yaml\`
- Process & PRs: \`blueprint/rules/blueprints/process.yaml\`
- TypeScript-specific: \`blueprint/rules/implementations/ts/\`

If a rule applies, follow it. If you choose to deviate, document why in the \
commit body and cite the rule ID you are deviating from.`;
}
