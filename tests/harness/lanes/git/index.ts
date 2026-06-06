/**
 * Git lane: runs the scenario through the system `git` binary in an
 * ephemeral local-disk repository.
 *
 * Sequence:
 *   1. `git init` in a per-scenario tmpdir.
 *   2. Copy `base/` into the working tree, commit as the root.
 *   3. Branch off `branch_a`, replace tree with scenario.branch_a, commit.
 *   4. Return to root, branch off `branch_b`, replace tree with branch_b, commit.
 *   5. Check out branch_a and `git merge branch_b --no-edit`.
 *   6. Capture outcome; the merged tree (or working tree on conflict) is
 *      handed off to the classifier.
 *
 * The lane never reaches the network; an optional sibling bare repo at
 * `<tmpdir>/remote.git` is available for scenarios that simulate push/pull
 * shapes locally.
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { run } from '../../isolation/proc';
import type { LaneResult, Scenario } from '../../types';

async function git(args: readonly string[], cwd: string) {
  const result = await run('git', args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd} (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result;
}

async function clearWorkingTree(repo: string) {
  // Remove everything except the .git directory.
  for (const entry of await readdir(repo, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    await rm(resolve(repo, entry.name), { recursive: true, force: true });
  }
}

async function copyTreeInto(src: string, dst: string) {
  await cp(src, dst, { recursive: true, dereference: false });
}

async function commitTree(repo: string, treeSrc: string, message: string) {
  await clearWorkingTree(repo);
  await copyTreeInto(treeSrc, repo);
  await git(['add', '-A'], repo);
  // Allow empty in case branch tree happens to equal parent tree.
  await git(['commit', '--allow-empty', '-m', message], repo);
}

export interface GitLaneArtifacts {
  /** Path to the working tree where the merge was attempted. */
  repo: string;
}

export async function runGitLane(
  scenario: Scenario,
  workdir: string,
): Promise<{ result: LaneResult; artifacts: GitLaneArtifacts }> {
  const start = performance.now();
  const repo = resolve(workdir, 'git');
  await mkdir(repo, { recursive: true });

  try {
    // Initialize a fresh repository on a stable default branch name so the
    // lane behaves identically regardless of the operator's git defaults.
    await git(['init', '--quiet', '--initial-branch=main'], repo);

    // Root commit from base/.
    await commitTree(repo, scenario.basePath, 'base');

    // branch_a from root.
    await git(['checkout', '-q', '-b', 'branch_a'], repo);
    await commitTree(repo, scenario.branchAPath, 'branch_a');

    // branch_b from root.
    await git(['checkout', '-q', 'main'], repo);
    await git(['checkout', '-q', '-b', 'branch_b'], repo);
    await commitTree(repo, scenario.branchBPath, 'branch_b');

    // Merge branch_b into branch_a.
    await git(['checkout', '-q', 'branch_a'], repo);
    const mergeResult = await run('git', ['merge', '--no-edit', '--no-ff', 'branch_b'], {
      cwd: repo,
    });

    const stdoutCombined = mergeResult.stdout;
    const stderrCombined = mergeResult.stderr;

    if (mergeResult.timedOut) {
      return {
        result: {
          outcome: 'error',
          reason: 'git merge timed out',
          stdout: stdoutCombined,
          stderr: stderrCombined,
          exitCode: mergeResult.exitCode,
          durationMs: performance.now() - start,
          mergedTreePath: repo,
        },
        artifacts: { repo },
      };
    }

    if (mergeResult.exitCode === 0) {
      // Clean merge — outcome is provisional (clean_ok or clean_wrong);
      // the classifier will decide based on expected/ and validator.sh.
      return {
        result: {
          outcome: 'clean_ok',
          stdout: stdoutCombined,
          stderr: stderrCombined,
          exitCode: 0,
          durationMs: performance.now() - start,
          mergedTreePath: repo,
        },
        artifacts: { repo },
      };
    }

    // Non-zero exit indicates conflict (or harder failures). Distinguish:
    // git merge writes "CONFLICT" lines on stdout for textual conflicts.
    const isConflict =
      /^CONFLICT/m.test(stdoutCombined) ||
      /Automatic merge failed/i.test(stdoutCombined + stderrCombined);

    return {
      result: {
        outcome: isConflict ? 'conflict' : 'error',
        reason: isConflict ? undefined : 'git merge exited non-zero without CONFLICT marker',
        stdout: stdoutCombined,
        stderr: stderrCombined,
        exitCode: mergeResult.exitCode,
        durationMs: performance.now() - start,
        mergedTreePath: repo,
      },
      artifacts: { repo },
    };
  } catch (e) {
    return {
      result: {
        outcome: 'error',
        reason: (e as Error).message,
        durationMs: performance.now() - start,
        mergedTreePath: repo,
      },
      artifacts: { repo },
    };
  }
}
