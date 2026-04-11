import { describe, it, expect } from "vitest";
import {
  parsePlan,
  serializePlan,
  insertCIFailureAtTop,
  appendToPhase,
  planContainsIssue,
  planIssueOrder,
  validatePlan,
  type Plan,
  type PlanIssueMetadata,
} from "../../plan.ts";

const scoutEntry: PlanIssueMetadata = {
  number: 196,
  title: "stub identity integration seams",
  phase: "Identity foundation",
  kind: "dev-scout",
  risk: 5,
  dependencies: [],
  parallel_safe: true,
};

const featureEntry: PlanIssueMetadata = {
  number: 201,
  title: "feat: build user authentication",
  phase: "Identity foundation",
  kind: "feature",
  risk: 4,
  dependencies: [196],
  parallel_safe: false,
};

const ciFailureEntry: PlanIssueMetadata = {
  number: 999,
  title: "fix(core): test:unit failed on main @ abc1234",
  phase: "watchdog",
  kind: "ci-failure",
  risk: 6,
  dependencies: [],
  parallel_safe: true,
};

describe("parsePlan", () => {
  it("parses an empty body as an empty plan", () => {
    expect(parsePlan("")).toEqual({ ciFailures: [], phases: [] });
  });

  it("parses a phase with a scout and a feature", () => {
    const body = `## Phase: Identity foundation

Goal: Create the auth and session seams.
Depends on phases: None.
Scout gate: #196

- #196 — [dev-scout] stub identity integration seams [risk: 5]
  <!-- superfield: ${JSON.stringify(scoutEntry)} -->
- #201 — feat: build user authentication [risk: 4]
  <!-- superfield: ${JSON.stringify(featureEntry)} -->
`;
    const plan = parsePlan(body);
    expect(plan.ciFailures).toEqual([]);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0]?.name).toBe("Identity foundation");
    expect(plan.phases[0]?.goal).toBe("Create the auth and session seams.");
    expect(plan.phases[0]?.dependsOn).toEqual([]);
    expect(plan.phases[0]?.scoutGate).toBe(196);
    expect(plan.phases[0]?.issues).toEqual([scoutEntry, featureEntry]);
  });

  it("parses top-of-plan ci-failure entries before phase blocks", () => {
    const body = `- #999 — fix(core): test:unit failed on main @ abc1234 [risk: 6]
  <!-- superfield: ${JSON.stringify(ciFailureEntry)} -->

## Phase: Identity foundation

Goal: Goal text.
Depends on phases: None.
Scout gate: #196

- #196 — [dev-scout] stub identity integration seams [risk: 5]
  <!-- superfield: ${JSON.stringify(scoutEntry)} -->
`;
    const plan = parsePlan(body);
    expect(plan.ciFailures).toEqual([ciFailureEntry]);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0]?.issues).toEqual([scoutEntry]);
  });

  it("parses dependsOn list", () => {
    const body = `## Phase: Later

Goal: after foundation.
Depends on phases: Identity foundation, Configuration
Scout gate: #300

`;
    const plan = parsePlan(body);
    expect(plan.phases[0]?.dependsOn).toEqual([
      "Identity foundation",
      "Configuration",
    ]);
  });

  it("skips orphan entry lines without metadata", () => {
    const body = `## Phase: P

Goal: g.
Depends on phases: None.
Scout gate: #1

- #42 — orphan entry with no metadata [risk: 3]
- #196 — [dev-scout] scout [risk: 5]
  <!-- superfield: ${JSON.stringify(scoutEntry)} -->
`;
    const plan = parsePlan(body);
    expect(plan.phases[0]?.issues).toEqual([scoutEntry]);
  });

  it("parses legacy calypso metadata and dash entry format", () => {
    const body = `## Phase: Identity foundation

Goal: legacy format.
Depends on phases: None.
Scout gate: #196

- #196 - scout identity
  <!-- calypso: {"number":196,"phase":"Identity foundation","kind":"dev-scout","dependencies":[],"parallel_safe":false} -->
- #201 - feat: build user authentication
  <!-- calypso: {"number":201,"phase":"Identity foundation","kind":"feature","dependencies":[196],"parallel_safe":false} -->
`;
    const plan = parsePlan(body);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0]?.issues).toHaveLength(2);
    expect(plan.phases[0]?.issues[0]).toMatchObject({
      number: 196,
      title: "scout identity",
      kind: "dev-scout",
      phase: "Identity foundation",
      dependencies: [],
      parallel_safe: false,
      risk: 3,
    });
    expect(plan.phases[0]?.issues[1]).toMatchObject({
      number: 201,
      title: "feat: build user authentication",
      kind: "feature",
      phase: "Identity foundation",
      dependencies: [196],
      parallel_safe: false,
      risk: 3,
    });
  });
});

describe("serializePlan", () => {
  it("round-trips a plan with ci-failures and a phase", () => {
    const plan: Plan = {
      ciFailures: [ciFailureEntry],
      phases: [
        {
          name: "Identity foundation",
          goal: "Create the auth and session seams.",
          dependsOn: [],
          scoutGate: 196,
          issues: [scoutEntry, featureEntry],
        },
      ],
    };
    const body = serializePlan(plan);
    expect(parsePlan(body)).toEqual(plan);
  });

  it('serializes dependsOn as "None." when empty', () => {
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: "P",
          goal: "g.",
          dependsOn: [],
          scoutGate: 1,
          issues: [scoutEntry],
        },
      ],
    };
    expect(serializePlan(plan)).toContain("Depends on phases: None.");
  });

  it("renders ci-failure entries before phase blocks", () => {
    const plan: Plan = {
      ciFailures: [ciFailureEntry],
      phases: [
        {
          name: "P",
          goal: "g.",
          dependsOn: [],
          scoutGate: 196,
          issues: [scoutEntry],
        },
      ],
    };
    const body = serializePlan(plan);
    const ciIdx = body.indexOf("#999");
    const phaseIdx = body.indexOf("## Phase:");
    expect(ciIdx).toBeGreaterThanOrEqual(0);
    expect(phaseIdx).toBeGreaterThan(ciIdx);
  });
});

describe("insertCIFailureAtTop", () => {
  it("prepends a ci-failure to an empty plan", () => {
    const plan: Plan = { ciFailures: [], phases: [] };
    const updated = insertCIFailureAtTop(plan, ciFailureEntry);
    expect(updated.ciFailures).toEqual([ciFailureEntry]);
  });

  it("dedupes by issue number and puts new entry first", () => {
    const older = { ...ciFailureEntry, title: "older title" };
    const plan: Plan = { ciFailures: [older], phases: [] };
    const updated = insertCIFailureAtTop(plan, ciFailureEntry);
    expect(updated.ciFailures).toEqual([ciFailureEntry]);
  });

  it("keeps other ci-failures in order", () => {
    const other: PlanIssueMetadata = { ...ciFailureEntry, number: 1000 };
    const plan: Plan = { ciFailures: [other], phases: [] };
    const updated = insertCIFailureAtTop(plan, ciFailureEntry);
    expect(updated.ciFailures).toEqual([ciFailureEntry, other]);
  });

  it("rejects non-ci-failure kinds", () => {
    const plan: Plan = { ciFailures: [], phases: [] };
    expect(() => insertCIFailureAtTop(plan, scoutEntry)).toThrow();
  });
});

describe("appendToPhase", () => {
  it("creates a new phase if it does not exist", () => {
    const plan: Plan = { ciFailures: [], phases: [] };
    const updated = appendToPhase(plan, "Identity foundation", scoutEntry);
    expect(updated.phases).toHaveLength(1);
    expect(updated.phases[0]?.issues).toEqual([scoutEntry]);
  });

  it("appends to an existing phase", () => {
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: "Identity foundation",
          goal: "",
          dependsOn: [],
          scoutGate: 196,
          issues: [scoutEntry],
        },
      ],
    };
    const updated = appendToPhase(plan, "Identity foundation", featureEntry);
    expect(updated.phases[0]?.issues).toEqual([scoutEntry, featureEntry]);
  });
});

describe("planContainsIssue", () => {
  it("returns true for issues in a phase", () => {
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: "P",
          goal: "",
          dependsOn: [],
          scoutGate: 1,
          issues: [scoutEntry],
        },
      ],
    };
    expect(planContainsIssue(plan, 196)).toBe(true);
    expect(planContainsIssue(plan, 999)).toBe(false);
  });

  it("returns true for top-of-plan ci-failures", () => {
    const plan: Plan = { ciFailures: [ciFailureEntry], phases: [] };
    expect(planContainsIssue(plan, 999)).toBe(true);
  });
});

describe("validatePlan", () => {
  it("returns empty array for a valid plan", () => {
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: "P",
          goal: "g.",
          dependsOn: [],
          scoutGate: 196,
          issues: [scoutEntry, featureEntry],
        },
      ],
    };
    expect(validatePlan(plan)).toEqual([]);
  });

  it("detects duplicate issue numbers", () => {
    const duplicate = { ...featureEntry, phase: "Other phase" };
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: "Identity foundation",
          goal: "",
          dependsOn: [],
          scoutGate: 196,
          issues: [scoutEntry, featureEntry],
        },
        {
          name: "Other phase",
          goal: "",
          dependsOn: [],
          scoutGate: null,
          issues: [duplicate],
        },
      ],
    };
    expect(
      validatePlan(plan).some((error) =>
        error.message.includes("duplicate issue #201"),
      ),
    ).toBe(true);
  });

  it("detects a forward dependency edge", () => {
    const lateScout: PlanIssueMetadata = {
      ...scoutEntry,
      number: 250,
      title: "late scout",
      phase: "Later",
    };
    const earlyFeature: PlanIssueMetadata = {
      ...featureEntry,
      number: 240,
      title: "early feature",
      phase: "Later",
      dependencies: [250],
    };
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: "Later",
          goal: "",
          dependsOn: [],
          scoutGate: 250,
          issues: [earlyFeature, lateScout],
        },
      ],
    };
    expect(
      validatePlan(plan).some((error) =>
        error.message.includes("depends on #250"),
      ),
    ).toBe(true);
  });

  it("detects a phase with no dev-scout", () => {
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: "Identity foundation",
          goal: "",
          dependsOn: [],
          scoutGate: null,
          issues: [featureEntry],
        },
      ],
    };
    expect(
      validatePlan(plan).some((error) =>
        error.message.includes("has no dev-scout"),
      ),
    ).toBe(true);
  });

  it("detects a phase with scout not in first position", () => {
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: "Identity foundation",
          goal: "",
          dependsOn: [],
          scoutGate: 196,
          issues: [featureEntry, scoutEntry],
        },
      ],
    };
    expect(
      validatePlan(plan).some((error) =>
        error.message.includes("scout is not first"),
      ),
    ).toBe(true);
  });

  it("detects a cyclic phase dependency", () => {
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: "A",
          goal: "",
          dependsOn: ["B"],
          scoutGate: 1,
          issues: [{ ...scoutEntry, number: 1, phase: "A" }],
        },
        {
          name: "B",
          goal: "",
          dependsOn: ["A"],
          scoutGate: 2,
          issues: [{ ...scoutEntry, number: 2, phase: "B" }],
        },
      ],
    };
    expect(
      validatePlan(plan).some((error) => error.message.includes("has a cycle")),
    ).toBe(true);
  });
});

// ── Property-based round-trip tests ──────────────────────────────────────────
// No external library needed — we generate representative Plan structures
// inline and verify parsePlan(serializePlan(plan)) deep-equals the original.

/** Generates a PlanIssueMetadata with deterministic values from an integer seed. */
function genEntry(seed: number, phase: string): PlanIssueMetadata {
  const kinds = ["feature", "dev-scout", "ci-failure"] as const;
  return {
    number: 100 + seed,
    title: `feat: item ${seed}`,
    phase,
    kind: kinds[seed % 3]!,
    risk: (seed % 10) + 1,
    dependencies: seed > 0 ? [100 + seed - 1] : [],
    parallel_safe: seed % 2 === 0,
  };
}

/** Generates a Plan with `phaseCount` phases, each containing `issuesPerPhase` issues. */
function genPlan(
  phaseCount: number,
  issuesPerPhase: number,
  hasCIFailures: boolean,
): Plan {
  let seed = 0;
  const ciFailures: PlanIssueMetadata[] = hasCIFailures
    ? [
        {
          number: 999,
          title: "fix(ci): test failed",
          phase: "watchdog",
          kind: "ci-failure",
          risk: 8,
          dependencies: [],
          parallel_safe: true,
        },
      ]
    : [];
  const phases = Array.from({ length: phaseCount }, (_, pi) => {
    const phaseName = `Phase ${pi + 1}`;
    const issues = Array.from({ length: issuesPerPhase }, () =>
      genEntry(seed++, phaseName),
    );
    return {
      name: phaseName,
      goal: `Goal of phase ${pi + 1}`,
      dependsOn: pi > 0 ? [`Phase ${pi}`] : [],
      scoutGate: issues[0]?.number ?? null,
      issues,
    };
  });
  return { ciFailures, phases };
}

describe("parsePlan + serializePlan — round-trip property", () => {
  const variants: Array<[string, Plan]> = [
    ["empty plan", { ciFailures: [], phases: [] }],
    ["single phase, one issue", genPlan(1, 1, false)],
    ["single phase, three issues", genPlan(1, 3, false)],
    ["two phases, two issues each", genPlan(2, 2, false)],
    [
      "ci-failures only, no phases",
      { ciFailures: [ciFailureEntry], phases: [] },
    ],
    ["ci-failures + two phases", genPlan(2, 2, true)],
    ["three phases, five issues each", genPlan(3, 5, false)],
    [
      "phase with null scoutGate",
      {
        ciFailures: [],
        phases: [
          {
            name: "P",
            goal: "g",
            dependsOn: [],
            scoutGate: null,
            issues: [featureEntry],
          },
        ],
      },
    ],
    [
      "phase with multiple dependsOn",
      {
        ciFailures: [],
        phases: [
          {
            name: "P2",
            goal: "",
            dependsOn: ["P0", "P1"],
            scoutGate: null,
            issues: [],
          },
        ],
      },
    ],
    ["issue with empty dependencies", genPlan(1, 1, false)],
  ];

  for (const [label, plan] of variants) {
    it(`round-trips: ${label}`, () => {
      const serialized = serializePlan(plan);
      const reparsed = parsePlan(serialized);
      expect(reparsed).toEqual(plan);
    });
  }

  it("serialized text is deterministic (pure function)", () => {
    const plan = genPlan(2, 3, true);
    expect(serializePlan(plan)).toBe(serializePlan(plan));
  });

  it("planIssueOrder is stable across round-trip", () => {
    const plan = genPlan(2, 3, true);
    const original = planIssueOrder(plan);
    const reparsed = parsePlan(serializePlan(plan));
    expect(planIssueOrder(reparsed)).toEqual(original);
  });
});

describe("planIssueOrder", () => {
  it("returns ci-failures before phase issues", () => {
    const plan: Plan = {
      ciFailures: [ciFailureEntry],
      phases: [
        {
          name: "P",
          goal: "",
          dependsOn: [],
          scoutGate: 196,
          issues: [scoutEntry, featureEntry],
        },
      ],
    };
    expect(planIssueOrder(plan)).toEqual([999, 196, 201]);
  });
});

// ── validatePlan stubs ────────────────────────────────────────────────────────
// Scaffolded by issue #28 for implementation in issue #16.

describe("validatePlan", () => {
  it("returns empty array for a valid plan", () => {
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: "P",
          goal: "g.",
          dependsOn: [],
          scoutGate: 196,
          issues: [scoutEntry, featureEntry],
        },
      ],
    };
    expect(validatePlan(plan)).toEqual([]);
  });

  it.todo("detects duplicate issue numbers");

  it.todo("detects a forward dependency edge (dep references a later issue)");

  it.todo("detects a phase with no dev-scout");

  it.todo("detects a phase with scout not in first position");

  it.todo("detects a cyclic phase dependency (A dependsOn B, B dependsOn A)");

  it.todo(
    "returns errors that include the offending issue number or phase name",
  );
});
