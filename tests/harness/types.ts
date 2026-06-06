/**
 * Core types for the Sharp differential test harness.
 *
 * The harness compares the `git` lane against the `sharp` lane (currently a
 * stub) on the same scenario fixtures. Each lane produces a typed `Outcome`;
 * the harness's contingency table is built over (git_outcome × sharp_outcome).
 *
 * The five outcomes encode the failure-mode taxonomy from
 * docs/test-plan.md §6 and §6.1. `dilemma` is Sharp-only — it represents
 * Sharp's deliberate refusal to silently pick between two semantically
 * valid resolutions. The git lane has no equivalent and reports `conflict`
 * when it cannot decide.
 */
export type Outcome = 'clean_ok' | 'clean_wrong' | 'conflict' | 'dilemma' | 'error';

export type LaneId = 'git' | 'sharp';

export interface LaneResult {
  /** Final classification. */
  outcome: Outcome;
  /** Free-form explanation surfaced in reports and failure artifacts. */
  reason?: string;
  /** Path to the merged tree on disk, if a tree was produced. */
  mergedTreePath?: string;
  /** Captured stdout/stderr from the lane's primary subprocess, when relevant. */
  stdout?: string;
  stderr?: string;
  /** Exit code of the lane's primary subprocess, when relevant. */
  exitCode?: number;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
}

export interface ScenarioMeta {
  name: string;
  category: ScenarioCategory;
  language: ScenarioLanguage;
  summary: string;
  /** Documented expected git-lane outcome. Verified empirically by the harness. */
  expected_git_outcome: Outcome;
  /** Documented target Sharp outcome. The scenario passes iff Sharp matches this. */
  expected_sharp_outcome: Outcome;
  /**
   * Validator selector. 'ts' / 'rust' point at stock validators under
   * tests/validators/; a relative path points at a fixture-local script.
   * Omitted = no behavioral validator (rely on expected/ alone).
   */
  validator?: 'ts' | 'rust' | string;
  /** Optional free-form notes (rationale, especially for dilemma scenarios). */
  notes?: string;
}

export type ScenarioCategory =
  | 'refactor'
  | 'reorder'
  | 'format'
  | 'move_edit'
  | 'delete_edit'
  | 'import_merge'
  | 'cross_file_rename'
  | 'whitespace_only';

export type ScenarioLanguage = 'ts' | 'rust';

export interface Scenario {
  /** Stable identifier of the form `<category>/<language>/<name>`. */
  id: string;
  /** Absolute path to the fixture directory. */
  path: string;
  meta: ScenarioMeta;
  /** Absolute path to the `base/` tree (always present). */
  basePath: string;
  /** Absolute path to the `branch_a/` tree. */
  branchAPath: string;
  /** Absolute path to the `branch_b/` tree. */
  branchBPath: string;
  /** Absolute path to `expected/`, when the scenario has a single canonical answer. */
  expectedPath?: string;
  /**
   * Absolute path to a `.ts` validator script the harness will run with
   * `bun`, when the scenario validates behaviorally. Resolved from
   * meta.validator (stock keyword or relative path).
   */
  validatorPath?: string;
  /**
   * Absolute paths to additional branches (`branch_c/`, `branch_d/`, …) that
   * Sharp's Tier 2 oracle path may consult. Not merge inputs. Empty when the
   * scenario provides no oracle branches.
   */
  oracleBranchPaths: string[];
}

export interface ScenarioResult {
  scenario: Scenario;
  git: LaneResult;
  sharp: LaneResult;
  /** True iff sharp.outcome matches scenario.meta.expected_sharp_outcome. */
  pass: boolean;
}

export interface RunResult {
  scenarios: ScenarioResult[];
  /** Walltime duration of the whole run in milliseconds. */
  durationMs: number;
}
