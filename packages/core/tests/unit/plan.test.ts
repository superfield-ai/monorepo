import { describe, it, expect } from 'vitest';
import {
  parsePlan,
  serializePlan,
  insertCIFailureAtTop,
  appendToPhase,
  planContainsIssue,
  planIssueOrder,
  type Plan,
  type PlanIssueMetadata,
} from '../../plan.ts';

const scoutEntry: PlanIssueMetadata = {
  number: 196,
  title: 'stub identity integration seams',
  phase: 'Identity foundation',
  kind: 'dev-scout',
  risk: 5,
  dependencies: [],
  parallel_safe: true,
};

const featureEntry: PlanIssueMetadata = {
  number: 201,
  title: 'feat: build user authentication',
  phase: 'Identity foundation',
  kind: 'feature',
  risk: 4,
  dependencies: [196],
  parallel_safe: false,
};

const ciFailureEntry: PlanIssueMetadata = {
  number: 999,
  title: 'fix(core): test:unit failed on main @ abc1234',
  phase: 'watchdog',
  kind: 'ci-failure',
  risk: 6,
  dependencies: [],
  parallel_safe: true,
};

describe('parsePlan', () => {
  it('parses an empty body as an empty plan', () => {
    expect(parsePlan('')).toEqual({ ciFailures: [], phases: [] });
  });

  it('parses a phase with a scout and a feature', () => {
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
    expect(plan.phases[0]?.name).toBe('Identity foundation');
    expect(plan.phases[0]?.goal).toBe('Create the auth and session seams.');
    expect(plan.phases[0]?.dependsOn).toEqual([]);
    expect(plan.phases[0]?.scoutGate).toBe(196);
    expect(plan.phases[0]?.issues).toEqual([scoutEntry, featureEntry]);
  });

  it('parses top-of-plan ci-failure entries before phase blocks', () => {
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

  it('parses dependsOn list', () => {
    const body = `## Phase: Later

Goal: after foundation.
Depends on phases: Identity foundation, Configuration
Scout gate: #300

`;
    const plan = parsePlan(body);
    expect(plan.phases[0]?.dependsOn).toEqual(['Identity foundation', 'Configuration']);
  });

  it('skips orphan entry lines without metadata', () => {
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
});

describe('serializePlan', () => {
  it('round-trips a plan with ci-failures and a phase', () => {
    const plan: Plan = {
      ciFailures: [ciFailureEntry],
      phases: [
        {
          name: 'Identity foundation',
          goal: 'Create the auth and session seams.',
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
        { name: 'P', goal: 'g.', dependsOn: [], scoutGate: 1, issues: [scoutEntry] },
      ],
    };
    expect(serializePlan(plan)).toContain('Depends on phases: None.');
  });

  it('renders ci-failure entries before phase blocks', () => {
    const plan: Plan = {
      ciFailures: [ciFailureEntry],
      phases: [
        { name: 'P', goal: 'g.', dependsOn: [], scoutGate: 196, issues: [scoutEntry] },
      ],
    };
    const body = serializePlan(plan);
    const ciIdx = body.indexOf('#999');
    const phaseIdx = body.indexOf('## Phase:');
    expect(ciIdx).toBeGreaterThanOrEqual(0);
    expect(phaseIdx).toBeGreaterThan(ciIdx);
  });
});

describe('insertCIFailureAtTop', () => {
  it('prepends a ci-failure to an empty plan', () => {
    const plan: Plan = { ciFailures: [], phases: [] };
    const updated = insertCIFailureAtTop(plan, ciFailureEntry);
    expect(updated.ciFailures).toEqual([ciFailureEntry]);
  });

  it('dedupes by issue number and puts new entry first', () => {
    const older = { ...ciFailureEntry, title: 'older title' };
    const plan: Plan = { ciFailures: [older], phases: [] };
    const updated = insertCIFailureAtTop(plan, ciFailureEntry);
    expect(updated.ciFailures).toEqual([ciFailureEntry]);
  });

  it('keeps other ci-failures in order', () => {
    const other: PlanIssueMetadata = { ...ciFailureEntry, number: 1000 };
    const plan: Plan = { ciFailures: [other], phases: [] };
    const updated = insertCIFailureAtTop(plan, ciFailureEntry);
    expect(updated.ciFailures).toEqual([ciFailureEntry, other]);
  });

  it('rejects non-ci-failure kinds', () => {
    const plan: Plan = { ciFailures: [], phases: [] };
    expect(() => insertCIFailureAtTop(plan, scoutEntry)).toThrow();
  });
});

describe('appendToPhase', () => {
  it('creates a new phase if it does not exist', () => {
    const plan: Plan = { ciFailures: [], phases: [] };
    const updated = appendToPhase(plan, 'Identity foundation', scoutEntry);
    expect(updated.phases).toHaveLength(1);
    expect(updated.phases[0]?.issues).toEqual([scoutEntry]);
  });

  it('appends to an existing phase', () => {
    const plan: Plan = {
      ciFailures: [],
      phases: [
        {
          name: 'Identity foundation',
          goal: '',
          dependsOn: [],
          scoutGate: 196,
          issues: [scoutEntry],
        },
      ],
    };
    const updated = appendToPhase(plan, 'Identity foundation', featureEntry);
    expect(updated.phases[0]?.issues).toEqual([scoutEntry, featureEntry]);
  });
});

describe('planContainsIssue', () => {
  it('returns true for issues in a phase', () => {
    const plan: Plan = {
      ciFailures: [],
      phases: [{ name: 'P', goal: '', dependsOn: [], scoutGate: 1, issues: [scoutEntry] }],
    };
    expect(planContainsIssue(plan, 196)).toBe(true);
    expect(planContainsIssue(plan, 999)).toBe(false);
  });

  it('returns true for top-of-plan ci-failures', () => {
    const plan: Plan = { ciFailures: [ciFailureEntry], phases: [] };
    expect(planContainsIssue(plan, 999)).toBe(true);
  });
});

describe('planIssueOrder', () => {
  it('returns ci-failures before phase issues', () => {
    const plan: Plan = {
      ciFailures: [ciFailureEntry],
      phases: [
        {
          name: 'P',
          goal: '',
          dependsOn: [],
          scoutGate: 196,
          issues: [scoutEntry, featureEntry],
        },
      ],
    };
    expect(planIssueOrder(plan)).toEqual([999, 196, 201]);
  });
});
