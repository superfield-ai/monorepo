/**
 * Final classification: turn a lane's raw merge result plus the scenario's
 * declared expectations into a typed `Outcome`.
 *
 * Decision tree:
 *   - lane already returned `error`        → error
 *   - lane already returned `dilemma`      → dilemma (Sharp lane only)
 *   - lane returned `conflict`             → conflict
 *   - lane returned `clean_ok` provisional → run validator and tree-compare
 *       - both succeed (or only one is provided and it succeeds) → clean_ok
 *       - either fails                                            → clean_wrong
 *   - merged tree contains conflict markers despite clean exit    → conflict
 */
import type { LaneResult, Outcome, Scenario } from '../types';
import { hasConflictMarkers } from './conflictMarkers';
import { compareTrees, describeTreeDiff } from './treeCompare';
import { runValidator } from '../validators/runner';

export async function classify(scenario: Scenario, lane: LaneResult): Promise<LaneResult> {
  // Outcomes that are already definitive.
  if (lane.outcome === 'error' || lane.outcome === 'dilemma') return lane;
  if (lane.outcome === 'conflict') return lane;

  // From here on the lane reported a provisional clean_ok.
  if (lane.outcome !== 'clean_ok' || !lane.mergedTreePath) {
    return {
      ...lane,
      outcome: 'error',
      reason: lane.reason ?? 'clean_ok lane result without mergedTreePath',
    };
  }

  // Defense against silent leftover conflict markers.
  if (await hasConflictMarkers(lane.mergedTreePath)) {
    return {
      ...lane,
      outcome: 'conflict',
      reason: 'conflict markers present in merged tree despite clean exit',
    };
  }

  const failureReasons: string[] = [];

  // Tree compare against expected/, when present.
  if (scenario.expectedPath) {
    const diff = await compareTrees(scenario.expectedPath, lane.mergedTreePath);
    if (!diff.equal) {
      failureReasons.push(`tree compare: ${describeTreeDiff(diff)}`);
    }
  }

  // Validator, when present.
  if (scenario.validatorPath) {
    const v = await runValidator(scenario.validatorPath, lane.mergedTreePath);
    if (!v.ok) {
      failureReasons.push(
        v.timedOut
          ? 'validator timed out'
          : `validator exited ${v.exitCode}: ${v.stderr.trim().split('\n').slice(-3).join(' | ')}`,
      );
    }
  }

  if (failureReasons.length === 0) {
    return { ...lane, outcome: 'clean_ok' };
  }

  return {
    ...lane,
    outcome: 'clean_wrong',
    reason: failureReasons.join('; '),
  };
}

/** True iff the scenario passed (Sharp lane's outcome matched expectations). */
export function pass(scenario: Scenario, sharpOutcome: Outcome): boolean {
  return sharpOutcome === scenario.meta.expected_sharp_outcome;
}
