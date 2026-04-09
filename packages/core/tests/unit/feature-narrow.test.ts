import { describe, it, expect } from "vitest";
import { buildFeatureNarrowPrompt } from "../../prompts/feature-narrow.ts";

const baseCtx = {
  request: "add a logout button",
  planBody: null,
  openIssueTitles: [],
  candidateDomains: ["auth"],
  candidateApproach:
    "Add a NavBar button that calls authService.signOut() and redirects to /login.",
};

describe("feature-narrow prompt (#83)", () => {
  it("narrow prompt contains implementation rules for candidate domains", () => {
    const prompt = buildFeatureNarrowPrompt(baseCtx);
    expect(prompt).toContain(
      "## Blueprint implementation rules (narrowing pass — refine the solution)",
    );
    // principles header must NOT appear — that's the first pass
    expect(prompt).not.toContain(
      "## Blueprint principles (exploratory context",
    );
  });

  it("narrow prompt references the candidateApproach string verbatim", () => {
    const prompt = buildFeatureNarrowPrompt(baseCtx);
    expect(prompt).toContain(baseCtx.candidateApproach);
  });

  it("narrow prompt allows declaring implementation conflicts", () => {
    const prompt = buildFeatureNarrowPrompt(baseCtx);
    expect(prompt).toContain("implementationConflicts");
    expect(prompt).toContain("if a rule genuinely");
  });
});
