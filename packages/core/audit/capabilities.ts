import { loadBlueprintSync } from "../blueprint.ts";

export interface AuditCapability {
  id: string;
  name: string;
  description: string;
  /** Hints passed to the agent about what patterns and files to look for. */
  lookFor: string[];
  /** Related blueprint rule IDs for cross-linking in generated issues. */
  blueprintRuleIds?: string[];
}

/**
 * Derives the audit capability set from the bundled blueprint at module load
 * time. Only checklist rules that are not deprecated are included. Each rule
 * maps 1-to-1 to an AuditCapability using the rule's name, description, and
 * rule-number identifier.
 */
export const CAPABILITIES: readonly AuditCapability[] = (() => {
  const blueprint = loadBlueprintSync();
  const capabilities: AuditCapability[] = [];

  for (const domain of blueprint.domains.values()) {
    for (const rule of domain.rules) {
      if (rule.type === "checklist" && rule.deprecated !== true) {
        capabilities.push({
          id: rule.name,
          name: rule.number,
          description: rule.description.trim(),
          lookFor: [rule.description.trim()],
          blueprintRuleIds: [rule.number],
        });
      }
    }
  }

  return capabilities;
})();

export function getCapability(id: string): AuditCapability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}
