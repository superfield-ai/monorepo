import { describe, it, expect } from "vitest";
import {
  renderIssueBody,
  isConformantBody,
  type IssueBody,
} from "../../issue-body.ts";

const sample: IssueBody = {
  title: "feat: example",
  phase: "Identity",
  motivation: "Because reasons",
  features: ["Build the thing", "Test it"],
  test_plan: ["Verify the thing"],
  canonical_docs: ["docs/prd.md"],
};

describe("renderIssueBody", () => {
  it("renders the five required sections in order", () => {
    const body = renderIssueBody(sample);
    const phaseIdx = body.indexOf("## Phase");
    const motivationIdx = body.indexOf("## Motivation");
    const docsIdx = body.indexOf("## Canonical docs");
    const featuresIdx = body.indexOf("## Features");
    const testIdx = body.indexOf("## Test Plan");
    expect(phaseIdx).toBeGreaterThanOrEqual(0);
    expect(motivationIdx).toBeGreaterThan(phaseIdx);
    expect(docsIdx).toBeGreaterThan(motivationIdx);
    expect(featuresIdx).toBeGreaterThan(docsIdx);
    expect(testIdx).toBeGreaterThan(featuresIdx);
  });

  it("renders features as checkboxes", () => {
    const body = renderIssueBody(sample);
    expect(body).toContain("- [ ] Build the thing");
    expect(body).toContain("- [ ] Test it");
  });

  it("renders test_plan as checkboxes", () => {
    const body = renderIssueBody(sample);
    expect(body).toContain("- [ ] Verify the thing");
  });

  it("falls back to TBD checkbox when features is empty", () => {
    const body = renderIssueBody({ ...sample, features: [] });
    expect(body).toContain("## Features\n- [ ] TBD");
  });

  it("falls back to TBD checkbox when test_plan is empty", () => {
    const body = renderIssueBody({ ...sample, test_plan: [] });
    expect(body).toContain("## Test Plan\n- [ ] TBD");
  });

  it("renders (none) when canonical_docs is empty", () => {
    const body = renderIssueBody({ ...sample, canonical_docs: [] });
    expect(body).toContain("## Canonical docs\n- (none)");
  });

  it("does NOT include the title (title is the issue title, not body)", () => {
    const body = renderIssueBody(sample);
    expect(body).not.toContain("feat: example");
  });
});

describe("isConformantBody", () => {
  it("returns true for a body with all five sections", () => {
    expect(isConformantBody(renderIssueBody(sample))).toBe(true);
  });

  it("returns false when missing a section", () => {
    expect(
      isConformantBody(
        "## Phase\nx\n\n## Motivation\nx\n\n## Features\n- [ ] x",
      ),
    ).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isConformantBody("")).toBe(false);
  });
});
