import type { BlueprintRuleType } from "../../blueprint.ts";

/**
 * Build a narrow blueprint context fragment scoped to specific domains and
 * rule types, truncated to fit under a byte budget.
 *
 * Scout stub (issue #77) — always returns the empty string. Real behaviour:
 *
 * - Issue #79: returns implementation rules + antipatterns for `domains`,
 *   prefers non-deprecated rules, and truncates to `budgetBytes`.
 * - Issue #80: when escalation is requested by the agent, the caller passes a
 *   wider set of `ruleTypes` (principles + threats + architecture) so the
 *   next turn gets the expanded context without a prompt-regression elsewhere.
 */
export function buildBlueprintContextFragment(opts: {
  domains: string[];
  ruleTypes: BlueprintRuleType[];
  budgetBytes: number;
}): string {
  void opts;
  return "";
}
