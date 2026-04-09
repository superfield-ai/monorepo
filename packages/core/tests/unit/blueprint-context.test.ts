import { describe, it, expect } from "vitest";
import { buildBlueprintContextFragment } from "../../prompts/fragments/blueprint-context.ts";
import {
  loadBlueprintSync,
  type Blueprint,
  type BlueprintDomain,
  type BlueprintRule,
} from "../../blueprint.ts";

function makeBlueprint(domains: BlueprintDomain[]): Blueprint {
  return {
    corpusVersion: 1,
    generated: "test",
    ruleCount: domains.reduce((n, d) => n + d.rules.length, 0),
    nodes: [],
    domains: new Map(domains.map((d) => [d.name, d])),
  };
}

function rule(partial: Partial<BlueprintRule>): BlueprintRule {
  return {
    number: partial.number ?? "X-001",
    hash: partial.hash ?? "h",
    name: partial.name ?? "a-rule",
    type: partial.type ?? "implementation",
    description: partial.description ?? "short description",
    deprecated: partial.deprecated ?? false,
  };
}

describe("buildBlueprintContextFragment", () => {
  it("stub-safe: returns empty string on empty inputs", () => {
    expect(
      buildBlueprintContextFragment({
        domains: [],
        ruleTypes: [],
        budgetBytes: 0,
      }),
    ).toBe("");
  });

  it("returns only implementation + antipattern rules when requested", () => {
    const bp = makeBlueprint([
      {
        name: "arch",
        title: "Arch",
        vision: "",
        rules: [
          rule({ number: "ARCH-P-001", type: "principle", name: "p1" }),
          rule({ number: "ARCH-T-001", type: "threat", name: "t1" }),
          rule({ number: "ARCH-D-001", type: "design_pattern", name: "d1" }),
          rule({
            number: "ARCH-AP-001",
            type: "antipattern",
            name: "ap1",
            description: "anti description",
          }),
          rule({
            number: "IMPL-ARCH-001",
            type: "implementation",
            name: "impl1",
            description: "impl description",
          }),
        ],
      },
    ]);
    const out = buildBlueprintContextFragment({
      domains: ["arch"],
      ruleTypes: ["implementation", "antipattern"],
      budgetBytes: 8192,
      blueprint: bp,
    });
    expect(out).toContain("IMPL-ARCH-001");
    expect(out).toContain("ARCH-AP-001");
    expect(out).not.toContain("ARCH-P-001");
    expect(out).not.toContain("ARCH-T-001");
    expect(out).not.toContain("ARCH-D-001");
    expect(out).toContain("Implementation rules");
    expect(out).toContain("Antipatterns");
  });

  it("budget truncator respects budgetBytes cap", () => {
    const bp = makeBlueprint([
      {
        name: "arch",
        title: "Arch",
        vision: "",
        rules: Array.from({ length: 20 }, (_, i) =>
          rule({
            number: `IMPL-ARCH-${i}`,
            name: `rule-${i}`,
            description: "x".repeat(200),
          }),
        ),
      },
    ]);
    const out = buildBlueprintContextFragment({
      domains: ["arch"],
      ruleTypes: ["implementation"],
      budgetBytes: 500,
      blueprint: bp,
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(500);
  });

  it("prefers dropping deprecated rules first when truncating", () => {
    const bp = makeBlueprint([
      {
        name: "arch",
        title: "Arch",
        vision: "",
        rules: [
          rule({
            number: "IMPL-ARCH-DEP",
            name: "deprecated-rule",
            deprecated: true,
            description: "d".repeat(120),
          }),
          rule({
            number: "IMPL-ARCH-ACT",
            name: "active-rule",
            deprecated: false,
            description: "a".repeat(120),
          }),
        ],
      },
    ]);
    // Tight budget: only one fits.
    const out = buildBlueprintContextFragment({
      domains: ["arch"],
      ruleTypes: ["implementation"],
      budgetBytes: 450,
      blueprint: bp,
    });
    expect(out).toContain("IMPL-ARCH-ACT");
    expect(out).not.toContain("IMPL-ARCH-DEP");
  });

  it("omission footer appears when rules are dropped", () => {
    const bp = makeBlueprint([
      {
        name: "arch",
        title: "Arch",
        vision: "",
        rules: Array.from({ length: 10 }, (_, i) =>
          rule({
            number: `IMPL-ARCH-${i}`,
            name: `rule-${i}`,
            description: "x".repeat(200),
          }),
        ),
      },
    ]);
    const out = buildBlueprintContextFragment({
      domains: ["arch"],
      ruleTypes: ["implementation"],
      budgetBytes: 500,
      blueprint: bp,
    });
    expect(out).toMatch(/…\d+ rules omitted due to budget\./);
  });

  it("respects the budget on real bundled blueprint data", () => {
    const bp = loadBlueprintSync();
    const out = buildBlueprintContextFragment({
      domains: ["arch", "auth", "test", "process"],
      ruleTypes: ["implementation", "antipattern"],
      budgetBytes: 4096,
      blueprint: bp,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(4096);
    expect(out).toContain("## Blueprint rules");
  });
});
