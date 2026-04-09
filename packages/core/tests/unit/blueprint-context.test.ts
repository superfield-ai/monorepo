import { describe, it } from "vitest";
import { buildBlueprintContextFragment } from "../../prompts/fragments/blueprint-context.ts";

describe("buildBlueprintContextFragment (scout)", () => {
  it("stub returns empty string", () => {
    const out = buildBlueprintContextFragment({
      domains: [],
      ruleTypes: [],
      budgetBytes: 0,
    });
    if (out !== "") throw new Error("expected empty stub");
  });

  it.todo("returns implementation + antipattern rules under budget (#79)");
  it.todo("budget truncator respects budgetBytes (#79)");
  it.todo("prefers non-deprecated rules when truncating (#79)");
  it.todo("dev-loop first turn contains narrow context (#79)");
  it.todo("escalation injects principles + threats on second turn (#80)");
  it.todo("does not escalate twice (#80)");
});
