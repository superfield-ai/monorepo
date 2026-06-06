/**
 * Reporting: console summary, contingency table, per-scenario failure
 * artifacts, and JSON output.
 */
import { mkdir, rm, writeFile, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Outcome, RunResult, ScenarioResult } from '../types';

const OUTCOMES: Outcome[] = ['clean_ok', 'clean_wrong', 'conflict', 'dilemma', 'error'];

const isTty = process.stdout.isTTY ?? false;

function color(text: string, code: string): string {
  return isTty ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const green = (s: string) => color(s, '32');
const red = (s: string) => color(s, '31');
const yellow = (s: string) => color(s, '33');
const dim = (s: string) => color(s, '2');

function outcomeColor(o: Outcome): string {
  switch (o) {
    case 'clean_ok':
      return green(o);
    case 'clean_wrong':
    case 'error':
      return red(o);
    case 'conflict':
      return yellow(o);
    case 'dilemma':
      return color(o, '36'); // cyan
  }
}

export function printScenarioLine(r: ScenarioResult): void {
  const status = r.pass ? green('PASS') : red('FAIL');
  process.stdout.write(
    `${status} ${r.scenario.id} git=${outcomeColor(r.git.outcome)} sharp=${outcomeColor(r.sharp.outcome)}\n`,
  );
  if (!r.pass && r.sharp.reason) {
    process.stdout.write(`  ${dim('└─ ' + r.sharp.reason)}\n`);
  }
}

/**
 * Emit the (git × sharp) contingency table over all scenarios. The cells
 * the harness exists to highlight are (git=conflict, sharp=clean_ok) and
 * (git=clean_wrong, sharp=clean_ok) — those are wins for Sharp.
 */
export function printContingency(run: RunResult): void {
  const counts = new Map<string, number>();
  for (const r of run.scenarios) {
    const key = `${r.git.outcome}|${r.sharp.outcome}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const colWidth = Math.max(...OUTCOMES.map((o) => o.length), 6);
  const pad = (s: string) => s.padStart(colWidth);

  process.stdout.write('\n' + dim('Differential contingency (rows: git, cols: sharp)') + '\n');
  process.stdout.write('            ' + OUTCOMES.map((o) => pad(o)).join(' ') + '\n');
  for (const git of OUTCOMES) {
    const row = OUTCOMES.map((sharp) => {
      const n = counts.get(`${git}|${sharp}`) ?? 0;
      const cell = pad(n === 0 ? '·' : String(n));
      // Highlight Sharp wins: git failure that became a Sharp clean_ok.
      const isWin = sharp === 'clean_ok' && (git === 'conflict' || git === 'clean_wrong') && n > 0;
      return isWin ? green(cell) : cell;
    }).join(' ');
    process.stdout.write(pad(git) + '   ' + row + '\n');
  }
}

export function printSummary(run: RunResult): void {
  const total = run.scenarios.length;
  const passed = run.scenarios.filter((r) => r.pass).length;
  const failed = total - passed;
  const sec = (run.durationMs / 1000).toFixed(2);
  process.stdout.write(
    `\n${total} scenarios, ${green(`${passed} pass`)}, ${failed === 0 ? '0 fail' : red(`${failed} fail`)} (${sec}s)\n`,
  );
}

/**
 * Write a per-scenario failure dump under `tests/_failures/<id>/`. Includes
 * the merged trees from each lane, the expected tree if present, and a
 * `summary.txt` with classification reasons.
 */
export async function writeFailureArtifacts(
  failuresRoot: string,
  r: ScenarioResult,
): Promise<void> {
  const dst = resolve(failuresRoot, r.scenario.id.replaceAll('/', '__'));
  await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });

  const summary = [
    `scenario: ${r.scenario.id}`,
    `expected_git_outcome:    ${r.scenario.meta.expected_git_outcome}`,
    `actual_git_outcome:      ${r.git.outcome}`,
    `expected_sharp_outcome:  ${r.scenario.meta.expected_sharp_outcome}`,
    `actual_sharp_outcome:    ${r.sharp.outcome}`,
    '',
    'git lane:',
    `  reason:   ${r.git.reason ?? ''}`,
    `  exitCode: ${r.git.exitCode ?? ''}`,
    '',
    'sharp lane:',
    `  reason:   ${r.sharp.reason ?? ''}`,
    `  exitCode: ${r.sharp.exitCode ?? ''}`,
  ].join('\n');
  await writeFile(resolve(dst, 'summary.txt'), summary + '\n');

  if (r.git.stdout) await writeFile(resolve(dst, 'git.stdout.txt'), r.git.stdout);
  if (r.git.stderr) await writeFile(resolve(dst, 'git.stderr.txt'), r.git.stderr);
  if (r.sharp.stdout) await writeFile(resolve(dst, 'sharp.stdout.txt'), r.sharp.stdout);
  if (r.sharp.stderr) await writeFile(resolve(dst, 'sharp.stderr.txt'), r.sharp.stderr);

  if (r.git.mergedTreePath) {
    try {
      await cp(r.git.mergedTreePath, resolve(dst, 'git_merged_tree'), {
        recursive: true,
        filter: (src) => !src.endsWith('/.git'),
      });
    } catch {
      // tmpdir may already be cleaned up; ignore.
    }
  }
  if (r.scenario.expectedPath) {
    try {
      await cp(r.scenario.expectedPath, resolve(dst, 'expected_tree'), {
        recursive: true,
      });
    } catch {
      // ignore
    }
  }
}

export async function writeJsonReport(path: string, run: RunResult): Promise<void> {
  const payload = {
    duration_ms: run.durationMs,
    total: run.scenarios.length,
    passed: run.scenarios.filter((r) => r.pass).length,
    scenarios: run.scenarios.map((r) => ({
      id: r.scenario.id,
      pass: r.pass,
      meta: r.scenario.meta,
      git: {
        outcome: r.git.outcome,
        reason: r.git.reason,
        exit_code: r.git.exitCode,
        duration_ms: r.git.durationMs,
      },
      sharp: {
        outcome: r.sharp.outcome,
        reason: r.sharp.reason,
        exit_code: r.sharp.exitCode,
        duration_ms: r.sharp.durationMs,
      },
    })),
  };
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n');
}
