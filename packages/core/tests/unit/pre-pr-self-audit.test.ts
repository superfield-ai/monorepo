import { describe, it, expect } from "vitest";
import { runPrePRSelfAudit } from "../../steps/pre-pr-self-audit.ts";
import { buildPrePRSelfAuditPrompt } from "../../prompts/pre-pr-self-audit.ts";

describe("runPrePRSelfAudit (scout)", () => {
  it("stub returns conformant verdict", async () => {
    const r = await runPrePRSelfAudit({
      issueNumber: 1,
      diffSummary: "",
      candidateDomains: [],
    });
    expect(r.conformant).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("buildPrePRSelfAuditPrompt stub returns empty string", () => {
    const s = buildPrePRSelfAuditPrompt({
      issueNumber: 1,
      diffSummary: "",
      candidateDomains: [],
    });
    expect(s).toBe("");
  });

  it.todo("parses conformant verdict (#82)");
  it.todo("parses violating verdict (#82)");
  it.todo("dev-loop progresses on conformant (#82)");
  it.todo("dev-loop loops back on violating (#82)");
  it.todo("remediation cap enforced at 3 (#82)");
});
