import { describe, it, expect } from "vitest";
import {
  buildDevLoopHarness,
  type DevLoopScenario,
  type SeedGitHubOpts,
} from "./helpers/index.ts";

/**
 * End-to-end dev-loop scenarios for the escalation latch (#78) and the
 * pre-PR self-audit remediation loop (#81).
 *
 * These complement the happy-path tests in dev-loop.test.ts by driving
 * multi-tick cross-session-comment state through real `tickDevLoop` calls
 * against the harness from #93. Only the LLM spawn + GitHub REST layer
 * are faked; `runPrePRSelfAudit`, session persistence, and the
 * `WorktreeManager` all execute for real.
 */

const OWNER = "test-org";
const REPO = "test-repo";
const PHASE_NAME = "Escalation & remediation";

function planBody(entries: {
  scoutNumber: number;
  primaryNumber: number;
}): string {
  const phaseEntry = (
    number: number,
    kind: "dev-scout" | "feature",
    title: string,
  ): string => {
    const metadata = {
      number,
      title,
      phase: PHASE_NAME,
      kind,
      risk: 2,
      dependencies: [] as number[],
      parallel_safe: true,
    };
    const display = kind === "dev-scout" ? `[dev-scout] ${title}` : title;
    return (
      `- #${number} — ${display} [risk: 2]\n` +
      `  <!-- superfield: ${JSON.stringify(metadata)} -->`
    );
  };
  return (
    [
      `## Phase: ${PHASE_NAME}`,
      "",
      "Goal: drive the escalation + remediation paths",
      "Depends on phases: None.",
      `Scout gate: #${entries.scoutNumber}`,
      "",
      phaseEntry(entries.scoutNumber, "dev-scout", "chore: scout the phase"),
      phaseEntry(
        entries.primaryNumber,
        "feature",
        "feat(core): primary feature",
      ),
    ].join("\n") + "\n"
  );
}

function issueBody(): string {
  return [
    `## Phase\n\n${PHASE_NAME}`,
    "## Motivation\n\nExercise the escalation latch and remediation loop end-to-end.",
    "## Canonical docs\n\n- docs/prd.md",
    "## Features\n\n- [x] harness drives multi-tick state correctly",
    "## Test Plan\n\n- [x] tickDevLoop eventually returns closed=true",
  ].join("\n\n");
}

function seedFor(scoutNumber: number, primaryNumber: number): SeedGitHubOpts {
  return {
    owner: OWNER,
    repo: REPO,
    planBody: planBody({ scoutNumber, primaryNumber }),
    issues: [
      {
        number: scoutNumber,
        title: "chore: scout the phase",
        body: "scouted",
        state: "closed",
        labels: ["dev-scout"],
      },
      {
        number: primaryNumber,
        title: "feat(core): primary feature",
        body: issueBody(),
        state: "open",
        labels: ["feature"],
      },
    ],
    prs: [
      {
        number: 100,
        issueNumber: scoutNumber,
        head: `chore/${scoutNumber}-scout-the-phase`,
        base: "main",
        state: "closed",
        merged: true,
      },
    ],
  };
}

async function mergePRForIssue(args: {
  owner: string;
  repo: string;
  issueNumber: number;
  branch: string;
}): Promise<void> {
  const base = `https://api.github.com/repos/${args.owner}/${args.repo}`;
  const createResp = await fetch(`${base}/pulls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: `feat: close #${args.issueNumber}`,
      head: args.branch,
      base: "main",
      body: `closes #${args.issueNumber}`,
    }),
  });
  if (createResp.status !== 201) {
    throw new Error(
      `test harness: failed to open PR: ${createResp.status} ${await createResp.text()}`,
    );
  }
  const pr = (await createResp.json()) as { number: number };
  const mergeResp = await fetch(`${base}/pulls/${pr.number}/merge`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
  });
  if (mergeResp.status !== 200) {
    throw new Error(
      `test harness: failed to merge PR: ${mergeResp.status} ${await mergeResp.text()}`,
    );
  }
}

/** Reads the parsed session JSON from the MSW-backed comment store, if any. */
function readSessionMarker(
  comments: { body: string }[],
): Record<string, unknown> | null {
  const marker = "<!-- superfield-session:";
  const end = "-->";
  const sc = comments.find((c) => c.body.startsWith(marker));
  if (!sc) return null;
  const start = sc.body.indexOf("\n") + 1;
  const stop = sc.body.lastIndexOf(end);
  if (stop < 0) return null;
  try {
    return JSON.parse(sc.body.slice(start, stop).trim()) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

describe("dev loop — escalation + remediation e2e (#94)", () => {
  it("escalation latch persists across remediation loop", async () => {
    const scoutNumber = 30;
    const primaryNumber = 31;
    const github = seedFor(scoutNumber, primaryNumber);

    // Tick 1: develop requests escalation; audit conformant (no PR merge
    // side-effect yet, so the slot simply exits closed=false).
    // Tick 2: develop (checklist complete) runs with escalation latched;
    // audit conformant; the audit step's act hook merges the PR which
    // closes the issue before runSlot's post-audit close check.
    const scenario: DevLoopScenario = [
      {
        stage: "develop",
        fixture: "dev-loop-e2e/develop-needs-escalation",
      },
      { stage: "self-audit", fixture: "blueprint-self-audit-conformant" },
      {
        stage: "develop",
        fixture: "dev-loop-e2e/develop-checklist-complete",
      },
      {
        stage: "self-audit",
        fixture: "blueprint-self-audit-conformant",
        act: async () => {
          await mergePRForIssue({
            owner: OWNER,
            repo: REPO,
            issueNumber: primaryNumber,
            branch: `feat/${primaryNumber}-primary-feature`,
          });
        },
      },
    ];

    const harness = await buildDevLoopHarness({ github, scenario });
    try {
      // Tick 1: escalation requested, audit conformant, no PR → closed=false.
      const r1 = await harness.tickOnce();
      expect(r1.primaryIssue).toBe(primaryNumber);
      expect(r1.closed).toBe(false);

      // Session comment after tick 1 should have blueprintEscalated: true.
      const t1Marker = readSessionMarker(
        harness.state.getComments(primaryNumber),
      );
      expect(t1Marker).not.toBeNull();
      expect(t1Marker?.blueprintEscalated).toBe(true);

      // Tick 2: develop with escalation latched, audit, PR merged via act.
      const r2 = await harness.tickOnce();
      expect(r2.primaryIssue).toBe(primaryNumber);
      expect(r2.closed).toBe(true);

      // Final state: issue closed, PR merged, session comment deleted.
      expect(harness.state.getIssue(primaryNumber)?.state).toBe("closed");
      const pr = harness.state.getPRForIssue(primaryNumber);
      expect(pr?.merged).toBe(true);
      const remaining = harness.state.getComments(primaryNumber);
      expect(
        remaining.every((c) => !c.body.includes("<!-- superfield-session:")),
      ).toBe(true);

      // Prompt recording: assert the SECOND develop prompt (tick 2) carries
      // the expanded escalation fragment header, and the first does not.
      const developPrompts = harness.recordedPrompts.filter(
        (p) => p.stage === "develop",
      );
      expect(developPrompts.length).toBe(2);
      expect(developPrompts[0]!.prompt).not.toContain(
        "## Blueprint rules (expanded context — escalation)",
      );
      expect(developPrompts[1]!.prompt).toContain(
        "## Blueprint rules (expanded context — escalation)",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("remediation loop progresses after one violating audit", async () => {
    const scoutNumber = 40;
    const primaryNumber = 41;
    const github = seedFor(scoutNumber, primaryNumber);

    // Tick 1: develop (complete) + self-audit violating → loopback.
    // Tick 2: develop (complete, carries remediation section) + audit
    // conformant, PR merged via audit act hook.
    const scenario: DevLoopScenario = [
      {
        stage: "develop",
        fixture: "dev-loop-e2e/develop-checklist-complete",
      },
      { stage: "self-audit", fixture: "blueprint-self-audit-violating" },
      {
        stage: "develop",
        fixture: "dev-loop-e2e/develop-checklist-complete",
      },
      {
        stage: "self-audit",
        fixture: "blueprint-self-audit-conformant",
        act: async () => {
          await mergePRForIssue({
            owner: OWNER,
            repo: REPO,
            issueNumber: primaryNumber,
            branch: `feat/${primaryNumber}-primary-feature`,
          });
        },
      },
    ];

    const harness = await buildDevLoopHarness({ github, scenario });
    try {
      // Drive ticks until the slot closes, capped at 5 to avoid infinite
      // loops on bugs. The remediation loopback exits the slot with
      // closed=false; the next tick re-enters and runs the second pass.
      let closed = false;
      let sawMidState = false;
      for (let i = 0; i < 5 && !closed; i++) {
        const r = await harness.tickOnce();
        expect(r.primaryIssue).toBe(primaryNumber);
        closed = r.closed;
        if (!closed && !sawMidState) {
          // After the first violating audit, session comment should hold
          // selfAuditRemediationCount: 1 and the pending violations array.
          const marker = readSessionMarker(
            harness.state.getComments(primaryNumber),
          );
          expect(marker).not.toBeNull();
          expect(marker?.selfAuditRemediationCount).toBe(1);
          const pending = marker?.selfAuditPendingViolations as
            | { rule_id: string }[]
            | undefined;
          expect(Array.isArray(pending)).toBe(true);
          expect(pending?.length).toBeGreaterThan(0);
          expect(pending?.[0]?.rule_id).toBe("TEST-A-002");
          sawMidState = true;
        }
      }
      expect(closed).toBe(true);

      // Prompt recording: exactly two develop prompts. The second must
      // carry the remediation header and the violating rule_id.
      const developPrompts = harness.recordedPrompts.filter(
        (p) => p.stage === "develop",
      );
      expect(developPrompts.length).toBe(2);
      expect(developPrompts[0]!.prompt).not.toContain(
        "## Pending blueprint remediation",
      );
      expect(developPrompts[1]!.prompt).toContain(
        "## Pending blueprint remediation",
      );
      expect(developPrompts[1]!.prompt).toContain("TEST-A-002");

      // Final state: PR merged, issue closed, session comment cleared.
      expect(harness.state.getIssue(primaryNumber)?.state).toBe("closed");
      expect(harness.state.getPRForIssue(primaryNumber)?.merged).toBe(true);
      expect(
        harness.state
          .getComments(primaryNumber)
          .every((c) => !c.body.includes("<!-- superfield-session:")),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("remediation cap aborts the slot after 3 violating audits", async () => {
    const scoutNumber = 50;
    const primaryNumber = 51;
    const github = seedFor(scoutNumber, primaryNumber);

    // Three develop + violating-audit pairs drive the remediation count
    // from 0 → 3. The fourth tick re-enters the slot, sees count === CAP
    // at slot entry, and exits before spawning any develop turn. No PR is
    // ever opened and the issue stays open.
    const scenario: DevLoopScenario = [
      { stage: "develop", fixture: "dev-loop-e2e/develop-checklist-complete" },
      { stage: "self-audit", fixture: "blueprint-self-audit-violating" },
      { stage: "develop", fixture: "dev-loop-e2e/develop-checklist-complete" },
      { stage: "self-audit", fixture: "blueprint-self-audit-violating" },
      { stage: "develop", fixture: "dev-loop-e2e/develop-checklist-complete" },
      { stage: "self-audit", fixture: "blueprint-self-audit-violating" },
    ];

    const harness = await buildDevLoopHarness({ github, scenario });
    try {
      // Cap at 6 ticks. The fourth tick short-circuits at slot entry.
      for (let i = 0; i < 6; i++) {
        const r = await harness.tickOnce();
        expect(r.primaryIssue).toBe(primaryNumber);
        expect(r.closed).toBe(false);
      }

      // Session comment should show the cap value (never greater).
      const marker = readSessionMarker(
        harness.state.getComments(primaryNumber),
      );
      expect(marker).not.toBeNull();
      expect(marker?.selfAuditRemediationCount).toBe(3);

      // No PR opened, issue still open.
      expect(harness.state.getPRForIssue(primaryNumber)).toBeUndefined();
      expect(harness.state.getIssue(primaryNumber)?.state).toBe("open");

      // Exactly three develop prompts were spawned — the 4th+ ticks
      // short-circuited at the cap before any develop call.
      const developPrompts = harness.recordedPrompts.filter(
        (p) => p.stage === "develop",
      );
      expect(developPrompts.length).toBe(3);
    } finally {
      await harness.dispose();
    }
  });
});
