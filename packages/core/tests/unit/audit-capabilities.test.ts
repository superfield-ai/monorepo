import { describe, it, expect } from "vitest";
import { CAPABILITIES, getCapability } from "../../audit/capabilities.ts";

describe("CAPABILITIES (derived from blueprint checklist rules)", () => {
  it("is non-empty", () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
  });

  it("each capability has required fields", () => {
    for (const cap of CAPABILITIES) {
      expect(typeof cap.id).toBe("string");
      expect(cap.id.length).toBeGreaterThan(0);

      expect(typeof cap.name).toBe("string");
      expect(cap.name.length).toBeGreaterThan(0);

      expect(typeof cap.description).toBe("string");
      expect(cap.description.length).toBeGreaterThan(0);

      expect(Array.isArray(cap.lookFor)).toBe(true);
      expect(cap.lookFor.length).toBeGreaterThan(0);
    }
  });

  it("only includes checklist rules (ids match blueprint rule names, not numbers)", () => {
    // Blueprint rule names are kebab-case slugs; numbers are like ARCH-C-001.
    // Capabilities derived from checklist rules use name as id and number as name.
    for (const cap of CAPABILITIES) {
      // id should be a kebab-case slug (rule.name), not a rule number
      expect(cap.id).not.toMatch(/^[A-Z]+-[A-Z]-\d+$/);
      // name should be the rule number pattern like ARCH-C-001
      expect(cap.name).toMatch(/^[A-Z]+-[A-Z]-\d+$/);
    }
  });

  it("all capabilities have blueprintRuleIds referencing the source rule", () => {
    for (const cap of CAPABILITIES) {
      expect(Array.isArray(cap.blueprintRuleIds)).toBe(true);
      expect(cap.blueprintRuleIds!.length).toBeGreaterThan(0);
    }
  });

  it("getCapability returns the right entry by id", () => {
    const first = CAPABILITIES[0];
    if (!first) return; // already guarded by non-empty test above
    const found = getCapability(first.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(first.id);
  });

  it("getCapability returns undefined for unknown id", () => {
    expect(getCapability("this-does-not-exist-xyz")).toBeUndefined();
  });
});
