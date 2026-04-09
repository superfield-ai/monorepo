import { describe, it, expect } from "vitest";
import {
  buildDevLoopHarness,
  type DevLoopScenario,
  type SeedGitHubOpts,
} from "./helpers/index.ts";

/**
 * End-to-end dev loop integration test.
 *
 * Drives the production `tickDevLoop` entrypoint against the tickDevLoop e2e
 * harness (#93) which composes the in-tree bare git remote (#92) with the
 * stateful GitHub MSW suite (#95) and a scenario-driven replaySpawn.
 *
 * The harness runs real `runPrePRSelfAudit` and a real `WorktreeManager`
 * cloning from a localhost smart-HTTP git backend. Only the LLM spawn is
 * faked (via recorded/hand-authored fixtures) and only the GitHub REST
 * calls are intercepted (via MSW).
 */

const OWNER = "test-org";
const REPO = "test-repo";
const PHASE_NAME = "Happy path";

function planBody(entries: {
  scoutNumber: number;
  primaryNumber: number;
  extraFeature?: number;
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
  const lines: string[] = [
    `## Phase: ${PHASE_NAME}`,
    "",
    "Goal: drive the happy path to merge",
    "Depends on phases: None.",
    `Scout gate: #${entries.scoutNumber}`,
    "",
    phaseEntry(entries.scoutNumber, "dev-scout", "chore: scout the phase"),
    phaseEntry(entries.primaryNumber, "feature", "feat(core): primary feature"),
  ];
  if (entries.extraFeature !== undefined) {
    lines.push(
      phaseEntry(
        entries.extraFeature,
        "feature",
        "feat(core): companion feature",
      ),
    );
  }
  return lines.join("\n") + "\n";
}

function issueBody(): string {
  // Conformant IssueBody skeleton — both checklists have at least one checked
  // item so the develop agent's "checklist complete" signal fires on turn 1.
  return [
    `## Phase\n\n${PHASE_NAME}`,
    "## Motivation\n\nDrive the dev loop end-to-end under deterministic fixtures.",
    "## Canonical docs\n\n- docs/prd.md",
    "## Features\n\n- [x] harness wires collaborators correctly",
    "## Test Plan\n\n- [x] tickDevLoop returns closed=true",
  ].join("\n\n");
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

describe("dev loop — e2e harness scenarios", () => {
  it("happy path: scout merged, primary feature drives all 8 stages to merge (#93)", async () => {
    const scoutNumber = 10;
    const primaryNumber = 11;
    const github: SeedGitHubOpts = {
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

    const scenario: DevLoopScenario = [
      {
        stage: "develop",
        fixture: "dev-loop-e2e/develop-checklist-complete",
        // The agent's side-effect in production would be opening and merging
        // a PR. We replicate that here by driving the MSW-backed GitHub API
        // directly so runSlot sees the issue as closed after the audit.
        act: async () => {
          await mergePRForIssue({
            owner: OWNER,
            repo: REPO,
            issueNumber: primaryNumber,
            branch: `feat/${primaryNumber}-primary-feature`,
          });
        },
      },
      {
        stage: "self-audit",
        fixture: "blueprint-self-audit-conformant",
      },
    ];

    const harness = await buildDevLoopHarness({ github, scenario });
    try {
      const result = await harness.tickOnce();

      expect(result.primaryIssue).toBe(primaryNumber);
      expect(result.closed).toBe(true);
      expect(result.mergeGateBlocked).toEqual([]);
      expect(result.speculativeIssues).toEqual([]);

      // Issue moved to closed via the PR merge handler
      expect(harness.state.getIssue(primaryNumber)?.state).toBe("closed");

      // A PR exists for the primary and was merged
      const pr = harness.state.getPRForIssue(primaryNumber);
      expect(pr).toBeDefined();
      expect(pr?.merged).toBe(true);
      expect(pr?.state).toBe("closed");
      expect(pr?.base).toBe("main");

      // Session comment lifecycle: upserted twice (pending → real) then
      // deleted on close. Final state: no session marker remains.
      const remaining = harness.state.getComments(primaryNumber);
      expect(
        remaining.every((c) => !c.body.includes("<!-- superfield-session:")),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("happy path: speculative slot opens when scout already CLOSED on main (#93)", async () => {
    const scoutNumber = 20;
    const primaryNumber = 21;
    const companionNumber = 22;
    const github: SeedGitHubOpts = {
      owner: OWNER,
      repo: REPO,
      planBody: planBody({
        scoutNumber,
        primaryNumber,
        extraFeature: companionNumber,
      }),
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
        {
          number: companionNumber,
          title: "feat(core): companion feature",
          body: issueBody(),
          state: "open",
          labels: ["feature"],
        },
      ],
      prs: [
        {
          number: 200,
          issueNumber: scoutNumber,
          head: `chore/${scoutNumber}-scout-the-phase`,
          base: "main",
          state: "closed",
          merged: true,
        },
      ],
    };

    const scenario: DevLoopScenario = [
      // The primary and speculative slots run concurrently; stage detection
      // decides which fixture matches based on the prompt content, and the
      // dev loop issues two develop calls and two self-audit calls in any
      // order. Because detectStage keys off prompt substrings, the scenario
      // cursor just needs enough matching steps in the correct stage
      // sequence. We provide one develop + one self-audit per slot.
      {
        stage: "develop",
        fixture: "dev-loop-e2e/develop-checklist-complete",
        act: async ({ opts }) => {
          // Only the primary's develop call drives a PR merge. We detect
          // the primary by looking for its issue number in the prompt.
          if (opts.prompt.includes(`#${primaryNumber}`)) {
            await mergePRForIssue({
              owner: OWNER,
              repo: REPO,
              issueNumber: primaryNumber,
              branch: `feat/${primaryNumber}-primary-feature`,
            });
          }
        },
      },
      { stage: "self-audit", fixture: "blueprint-self-audit-conformant" },
      {
        stage: "develop",
        fixture: "dev-loop-e2e/develop-checklist-complete",
        act: async ({ opts }) => {
          if (opts.prompt.includes(`#${primaryNumber}`)) {
            await mergePRForIssue({
              owner: OWNER,
              repo: REPO,
              issueNumber: primaryNumber,
              branch: `feat/${primaryNumber}-primary-feature`,
            });
          }
        },
      },
      { stage: "self-audit", fixture: "blueprint-self-audit-conformant" },
    ];

    const harness = await buildDevLoopHarness({
      github,
      scenario,
      slotCount: 2,
    });
    try {
      const result = await harness.tickOnce();

      expect(result.primaryIssue).toBe(primaryNumber);
      expect(result.closed).toBe(true);
      expect(result.speculativeIssues).toEqual([companionNumber]);

      // Primary closed via merged PR
      expect(harness.state.getIssue(primaryNumber)?.state).toBe("closed");
      expect(harness.state.getPRForIssue(primaryNumber)?.merged).toBe(true);

      // Speculative slot ran but did not open a PR and stays open —
      // speculative slots exit after checklist-complete without opening a PR.
      expect(harness.state.getIssue(companionNumber)?.state).toBe("open");
      expect(harness.state.getPRForIssue(companionNumber)).toBeUndefined();
    } finally {
      await harness.dispose();
    }
  });
});
