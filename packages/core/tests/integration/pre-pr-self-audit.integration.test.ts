import { describe, it, expect } from "vitest";
import { runPrePRSelfAudit } from "../../steps/pre-pr-self-audit.ts";
import { replaySpawn } from "../helpers/replay.ts";
import type { Issue } from "@superfield/github";

/**
 * Layer-2 integration tests for the pre-PR blueprint self-audit step (#81).
 * Drives the production `runPrePRSelfAudit` entrypoint with hand-authored
 * Claude fixtures replayed via `replaySpawn`.
 *
 * Note on the remediation loopback: the full `tickDevLoop` end-to-end harness
 * (worktree provisioning, MSW GitHub stubs, deadman comments) is still
 * TODO in `tests/integration/dev-loop.test.ts`. We exercise the remediation
 * contract here at the step level: a violating audit followed by a
 * conformant audit threading the previous violations through, which is
 * exactly what the dev-loop will call once that harness lands.
 */

const issue: Issue = {
  number: 10,
  title: "feat: architecture refactor of package boundaries",
  body: "Split monorepo into clearer package boundaries.",
  html_url: "https://github.com/x/y/issues/10",
  state: "open",
  labels: [],
};

describe("runPrePRSelfAudit — replaySpawn integration", () => {
  it("returns conformant=true when the conformant fixture is replayed", async () => {
    const spawn = await replaySpawn("blueprint-self-audit-conformant");
    const result = await runPrePRSelfAudit({
      issue,
      repoPath: "/tmp/does-not-matter",
      spawn,
      diffSummary: "- modified: packages/core/agent.ts",
      candidateDomains: ["arch"],
    });
    expect(result.conformant).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("returns conformant=false with at least one violation rule_id when the violating fixture is replayed", async () => {
    const spawn = await replaySpawn("blueprint-self-audit-violating");
    const result = await runPrePRSelfAudit({
      issue,
      repoPath: "/tmp/does-not-matter",
      spawn,
      diffSummary: "- added: packages/core/tests/unit/foo.test.ts",
      candidateDomains: ["test"],
    });
    expect(result.conformant).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations[0]!.rule_id).toBe("TEST-A-002");
  });

  it("models the remediation loopback: violating audit followed by conformant audit clears violations", async () => {
    // First tick: violating
    const violatingSpawn = await replaySpawn("blueprint-self-audit-violating");
    const first = await runPrePRSelfAudit({
      issue,
      repoPath: "/tmp/does-not-matter",
      spawn: violatingSpawn,
      diffSummary: "- added: packages/core/tests/unit/foo.test.ts",
      candidateDomains: ["test"],
    });
    expect(first.conformant).toBe(false);
    expect(first.violations.length).toBeGreaterThan(0);

    // Second tick: dev-loop loops back to develop with `previousViolations`
    // and re-audits — this time the agent reports conformant.
    const conformantSpawn = await replaySpawn(
      "blueprint-self-audit-conformant",
    );
    const second = await runPrePRSelfAudit({
      issue,
      repoPath: "/tmp/does-not-matter",
      spawn: conformantSpawn,
      diffSummary: "- modified: packages/core/tests/unit/foo.test.ts",
      candidateDomains: ["test"],
      previousViolations: first.violations,
    });
    expect(second.conformant).toBe(true);
    expect(second.violations).toEqual([]);
  });
});
