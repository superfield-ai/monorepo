import { describe, it, expect } from "vitest";
import { buildFeatureEvaluatePrompt } from "../../prompts/feature-evaluate.ts";

const baseCtx = {
  request: "add a logout button",
  planBody: null,
  openIssueTitles: [],
  candidateDomains: ["auth"],
};

describe("feature-evaluate blueprint integration (#83)", () => {
  it("initial prompt contains principles, not implementation rules", () => {
    const prompt = buildFeatureEvaluatePrompt(baseCtx);
    expect(prompt).toContain(
      "## Blueprint principles (exploratory context — shape the solution freely)",
    );
    expect(prompt).not.toContain(
      "## Blueprint implementation rules (narrowing pass",
    );
    expect(prompt).not.toContain("### Implementation rules");
  });

  it("initial prompt does not contain antipatterns", () => {
    const prompt = buildFeatureEvaluatePrompt(baseCtx);
    expect(prompt).not.toContain("### Antipatterns");
  });

  it("output contract documents candidateApproach", () => {
    const prompt = buildFeatureEvaluatePrompt(baseCtx);
    expect(prompt).toContain("candidateApproach");
  });

  it("includes exploratory-instruction text discouraging premature rule-matching", () => {
    const prompt = buildFeatureEvaluatePrompt(baseCtx);
    expect(prompt).toContain(
      "Do not try to match specific implementation rules yet",
    );
  });
});
