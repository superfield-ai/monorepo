import { describe, expect, it } from "vitest";
import {
  buildStudioPrompt,
  parseSessionCommits,
  parseTimelineCommits,
  parseControlInfo,
  validateRollbackHash,
  validateControlMessage,
  type ControlMessage,
} from "../../src/helpers";

describe("parseControlInfo", () => {
  it("parses valid studio session JSON", () => {
    expect(
      parseControlInfo(
        '{"sessionId":"a1b2","branch":"studio/session-main-a1b2"}',
      ),
    ).toEqual({
      sessionId: "a1b2",
      branch: "studio/session-main-a1b2",
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseControlInfo("{not json")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseControlInfo('{"sessionId":"a1b2"}')).toBeNull();
    expect(
      parseControlInfo('{"branch":"studio/session-main-a1b2"}'),
    ).toBeNull();
  });
});

describe("parseSessionCommits", () => {
  it("returns an empty list for empty git log output", () => {
    expect(parseSessionCommits("")).toEqual([]);
    expect(parseSessionCommits("\n")).toEqual([]);
  });

  it("parses single and multiple commit lines", () => {
    expect(parseSessionCommits("abc1234 studio: start session")).toEqual([
      { hash: "abc1234", message: "studio: start session" },
    ]);

    expect(
      parseSessionCommits(
        [
          "def5678 studio: update header styles",
          "abc1234 studio: start session",
        ].join("\n"),
      ),
    ).toEqual([
      { hash: "def5678", message: "studio: update header styles" },
      { hash: "abc1234", message: "studio: start session" },
    ]);
  });
});

describe("buildStudioPrompt", () => {
  const messages: ControlMessage[] = [
    { role: "user", content: "Please group tasks by status." },
    { role: "assistant", content: "I grouped them by status." },
    { role: "user", content: "Now rename Tasks to Dispatches." },
  ];

  it("preserves the full conversation order", () => {
    const prompt = buildStudioPrompt({
      branch: "studio/session-main-a1b2",
      messages,
    });

    expect(prompt).toContain("Partner: Please group tasks by status.");
    expect(prompt).toContain("Agent: I grouped them by status.");
    expect(prompt).toContain("Partner: Now rename Tasks to Dispatches.");

    expect(
      prompt.indexOf("Partner: Please group tasks by status."),
    ).toBeLessThan(prompt.indexOf("Agent: I grouped them by status."));
    expect(prompt.indexOf("Agent: I grouped them by status.")).toBeLessThan(
      prompt.indexOf("Partner: Now rename Tasks to Dispatches."),
    );
  });

  it("includes changes.md context when provided", () => {
    const prompt = buildStudioPrompt({
      branch: "studio/session-main-a1b2",
      messages,
      changesContent: "# Studio Session\n\n## Changes\n",
    });

    expect(prompt).toContain("Current changes.md:");
    expect(prompt).toContain("# Studio Session");
  });

  it("omits changes.md context when absent", () => {
    const prompt = buildStudioPrompt({
      branch: "studio/session-main-a1b2",
      messages,
    });

    expect(prompt).not.toContain("Current changes.md:");
  });
});

describe("parseTimelineCommits", () => {
  it("parses structured git log output with hash, timestamp, and message", () => {
    const output = [
      "abc1234|2025-03-15T10:30:00+00:00|Updated the login form",
      "def5678|2025-03-15T10:45:00+00:00|Added a new sidebar",
    ].join("\n");

    const entries = parseTimelineCommits(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      hash: "abc1234",
      timestamp: "2025-03-15T10:30:00+00:00",
      message: "Updated the login form",
    });
    expect(entries[1]).toEqual({
      hash: "def5678",
      timestamp: "2025-03-15T10:45:00+00:00",
      message: "Added a new sidebar",
    });
  });

  it("handles messages containing pipe characters", () => {
    const output = "abc1234|2025-03-15T10:30:00+00:00|Updated | blue to red\n";
    const entries = parseTimelineCommits(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("Updated | blue to red");
  });

  it("returns empty array for empty output", () => {
    expect(parseTimelineCommits("")).toEqual([]);
  });

  it("skips malformed lines without two pipe separators", () => {
    const output = "no-pipes\nabc1234|2025-03-15T10:30:00+00:00|Valid\n";
    const entries = parseTimelineCommits(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toBe("abc1234");
  });

  it("handles a line with only one pipe separator", () => {
    const output = "abc1234|incomplete\n";
    const entries = parseTimelineCommits(output);
    expect(entries).toEqual([]);
  });
});

describe("request validation helpers", () => {
  it("accepts a non-empty message and trims surrounding whitespace", () => {
    expect(validateControlMessage("  update the header  ")).toBe(
      "update the header",
    );
  });

  it("rejects missing or blank chat messages", () => {
    expect(validateControlMessage("")).toBeNull();
    expect(validateControlMessage("   ")).toBeNull();
    expect(validateControlMessage(undefined)).toBeNull();
  });

  it("accepts a non-empty rollback hash and trims surrounding whitespace", () => {
    expect(validateRollbackHash("  abc1234  ")).toBe("abc1234");
  });

  it("rejects missing or blank rollback hashes", () => {
    expect(validateRollbackHash("")).toBeNull();
    expect(validateRollbackHash("   ")).toBeNull();
    expect(validateRollbackHash(undefined)).toBeNull();
  });
});
