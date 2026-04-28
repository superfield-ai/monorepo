import {
  loadBlueprintSync,
  type Blueprint,
  type BlueprintRule,
  type BlueprintRuleType,
} from "../../blueprint.ts";

/**
 * Build a narrow blueprint context fragment scoped to specific domains and
 * rule types, truncated to fit under a byte budget.
 *
 * Implementation rules live inside their parent domain (folded in at load
 * time — see blueprint.ts `buildFromBundled()`), so asking for `domains:
 * ["arch"]` with `ruleTypes: ["implementation","antipattern"]` transparently
 * pulls both the TS implementation rules for arch and its antipatterns.
 *
 * Budget handling:
 *   1. Deprecated rules are dropped first.
 *   2. If still over budget, the rules with the longest descriptions are
 *      dropped until the rendered text fits under `budgetBytes`.
 *   3. If any rules were dropped, an "…N rules omitted due to budget" footer
 *      is appended.
 *
 * Issues:
 *   - #80: first-turn callers pass `["implementation","antipattern"]`.
 *   - #81: escalation widens `ruleTypes` to principles/threats/architecture.
 */
export function buildBlueprintContextFragment(opts: {
  domains: string[];
  ruleTypes: BlueprintRuleType[];
  budgetBytes: number;
  blueprint?: Blueprint;
  /**
   * Optional header override. Defaults to the narrow first-pass header.
   * Escalation callers (#78) pass a distinct header so the expanded
   * fragment sits alongside the narrow one rather than replacing it.
   */
  header?: string;
}): string {
  const { domains, ruleTypes, budgetBytes } = opts;
  const header =
    opts.header ?? "## Blueprint rules (narrow context — first pass)";
  if (domains.length === 0 || ruleTypes.length === 0 || budgetBytes <= 0) {
    return "";
  }

  const blueprint = opts.blueprint ?? loadBlueprintSync();

  // Collect candidate rules, keyed by domain, in the order requested.
  type Entry = { domain: string; rule: BlueprintRule };
  const entries: Entry[] = [];
  for (const domainName of domains) {
    const domain = blueprint.domains.get(domainName);
    if (!domain) continue;
    for (const rule of domain.rules) {
      if (!ruleTypes.includes(rule.type)) continue;
      entries.push({ domain: domainName, rule });
    }
  }

  if (entries.length === 0) return "";

  // Priority ordering for drops: deprecated first, then longest-description.
  const dropOrder = [...entries]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const depA = a.e.rule.deprecated ? 1 : 0;
      const depB = b.e.rule.deprecated ? 1 : 0;
      if (depA !== depB) return depB - depA; // deprecated come first
      return b.e.rule.description.length - a.e.rule.description.length;
    })
    .map((x) => x.i);

  const dropped = new Set<number>();
  let rendered = render(entries, dropped, ruleTypes, 0, header);
  let di = 0;
  while (
    Buffer.byteLength(rendered, "utf8") > budgetBytes &&
    di < dropOrder.length
  ) {
    const next = dropOrder[di];
    if (next !== undefined) dropped.add(next);
    di++;
    rendered = render(entries, dropped, ruleTypes, dropped.size, header);
  }

  return rendered;
}

function render(
  entries: Array<{ domain: string; rule: BlueprintRule }>,
  dropped: Set<number>,
  ruleTypes: BlueprintRuleType[],
  omittedCount: number,
  header: string,
): string {
  const lines: string[] = [];
  lines.push(header);
  lines.push(
    "Apply these rules to your work. Cite the rule ID in your commit body if you deviate.",
  );

  for (const type of ruleTypes) {
    const rulesOfType = entries
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => !dropped.has(i) && e.rule.type === type);
    if (rulesOfType.length === 0) continue;
    lines.push("");
    lines.push(`### ${labelForType(type)}`);
    for (const { e } of rulesOfType) {
      const dep = e.rule.deprecated ? " (deprecated)" : "";
      const desc = e.rule.description.trim().replace(/\s+/g, " ");
      lines.push(
        `- **${e.rule.number}** \`${e.rule.name}\`${dep} [${e.domain}]: ${desc}`,
      );
    }
  }

  if (omittedCount > 0) {
    lines.push("");
    lines.push(`…${omittedCount} rules omitted due to budget.`);
  }

  return lines.join("\n");
}

function labelForType(type: BlueprintRuleType): string {
  switch (type) {
    case "implementation":
      return "Implementation rules";
    case "antipattern":
      return "Antipatterns";
    case "principle":
      return "Principles";
    case "threat":
      return "Threats";
    case "architecture":
      return "Architecture";
    case "design_pattern":
      return "Design patterns";
    case "checklist":
      return "Checklist";
  }
}
