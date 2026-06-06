/**
 * Sharp lane.
 *
 * The lane runs each scenario through a real Sharp client/server. Trees
 * for base/branch_a/branch_b are committed via the HTTP API, then the
 * merge runs through Sharp's Tier 1 engine:
 *   - rename propagation across files A didn't touch
 *   - delete-then-edit emits a Tier 3 dilemma rather than auto-resolving
 *   - other conflict patterns fall back to a `git merge` shim until the
 *     remaining Phase 19+ strategies land
 */
import { mkdir, cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { snapshotAndCommit, type SharpClient } from '../../../../apps/client/src';
import { setOf, tier1Merge, type FileEntry } from '../../../../apps/client/src/merge';
import type { LaneResult, Scenario } from '../../types';

export interface SharpLaneContext {
  /** Pre-started Sharp client; the runner is responsible for setup/teardown. */
  client?: SharpClient;
  /** Reason the lane is unavailable (no docker, no server). Set by the runner. */
  unavailableReason?: string;
}

const PINNED_AUTHOR = {
  nameAndEmail: 'Sharp Test Harness <harness@sharp.test>',
  timestamp: 1735689600,
  timezone: '+0000',
};

/**
 * Read every file under `root` recursively into a path-keyed list of
 * {path, content}. Skips `.git/`, `node_modules/`, etc. so the merge
 * engine only sees source files.
 */
async function readTreeFromDisk(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.sharp' || entry.name === 'node_modules')
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const content = await readFile(full, 'utf8');
        out.push({ path: relative(root, full).replaceAll('\\', '/'), content });
      }
    }
  }
  await walk(root);
  return out;
}

async function materializeFiles(dest: string, files: Map<string, string>): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const [path, content] of files) {
    const full = join(dest, path);
    await mkdir(join(dest, path.split('/').slice(0, -1).join('/')), { recursive: true });
    await writeFile(full, content);
  }
  // Avoid unused-import warnings in environments where mkdtemp/tmpdir
  // aren't otherwise referenced.
  void mkdtemp;
  void tmpdir;
}

async function clearAndCopy(src: string, dst: string): Promise<void> {
  // Empty dst (preserving .git/.sharp), then copy src in.
  const { rm, readdir } = await import('node:fs/promises');
  for (const entry of await readdir(dst, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === '.git' || entry.name === '.sharp') continue;
    await rm(resolve(dst, entry.name), { recursive: true, force: true });
  }
  await cp(src, dst, { recursive: true });
}

export async function runSharpLane(
  scenario: Scenario,
  workdir: string,
  ctx: SharpLaneContext,
): Promise<LaneResult> {
  const start = performance.now();
  if (!ctx.client) {
    return {
      outcome: 'error',
      reason: ctx.unavailableReason ?? 'sharp client unavailable',
      durationMs: performance.now() - start,
    };
  }

  const repoRoot = resolve(workdir, 'sharp-tree');
  await mkdir(repoRoot, { recursive: true });
  const client = ctx.client;

  try {
    // Stage base/ → snapshot → commit as root.
    await clearAndCopy(scenario.basePath, repoRoot);
    const baseId = await snapshotAndCommit(client, {
      root: repoRoot,
      parents: [],
      refName: refNameFor(scenario, 'main'),
      author: PINNED_AUTHOR,
      committer: PINNED_AUTHOR,
      message: 'base\n',
    });

    // Stage branch_a → snapshot → commit on top.
    await clearAndCopy(scenario.branchAPath, repoRoot);
    const aId = await snapshotAndCommit(client, {
      root: repoRoot,
      parents: [baseId],
      refName: refNameFor(scenario, 'branch_a'),
      author: PINNED_AUTHOR,
      committer: PINNED_AUTHOR,
      message: 'branch_a\n',
    });

    // Stage branch_b → snapshot → commit (parent = base, NOT a).
    await clearAndCopy(scenario.branchBPath, repoRoot);
    const bId = await snapshotAndCommit(client, {
      root: repoRoot,
      parents: [baseId],
      refName: refNameFor(scenario, 'branch_b'),
      author: PINNED_AUTHOR,
      committer: PINNED_AUTHOR,
      message: 'branch_b\n',
    });

    // Tier 1 merge engine: rename propagation across files A didn't
    // touch; delete-then-edit emits a Tier 3 dilemma.
    const baseFiles = await readTreeFromDisk(scenario.basePath);
    const aFiles = await readTreeFromDisk(scenario.branchAPath);
    const bFiles = await readTreeFromDisk(scenario.branchBPath);

    // Load oracle branches (branch_c/, branch_d/, …) for Tier 2 oracle
    // scoring when Tier 1 produces multiple candidates (whitepaper §6.4).
    const oracleFileSets = await Promise.all(
      scenario.oracleBranchPaths.map(async (p) => setOf(await readTreeFromDisk(p))),
    );

    const tier1 = await tier1Merge(setOf(baseFiles), setOf(aFiles), setOf(bFiles), {
      oracleBranches: oracleFileSets,
    });

    if (tier1.outcome === 'dilemma') {
      return {
        outcome: 'dilemma',
        reason: tier1.dilemma?.reason,
        durationMs: performance.now() - start,
      };
    }

    if (tier1.outcome === 'clean_ok') {
      // Materialize the engine's merged tree, snapshot back into Sharp,
      // produce a merge commit linking both parents.
      const mergedDir = resolve(workdir, 'sharp-merged');
      await materializeFiles(mergedDir, tier1.files!);
      await snapshotAndCommit(client, {
        root: mergedDir,
        parents: [aId, bId],
        refName: refNameFor(scenario, 'merge'),
        author: PINNED_AUTHOR,
        committer: PINNED_AUTHOR,
        message: 'merge of branch_b into branch_a\n',
      });
      return {
        outcome: 'clean_ok',
        reason:
          tier1.renamesApplied && tier1.renamesApplied.length > 0
            ? `tier1: rename propagation (${tier1.renamesApplied
                .map((r) => `${r.oldName}→${r.newName}`)
                .join(', ')})`
            : 'tier1: trivial merge',
        mergedTreePath: mergedDir,
        durationMs: performance.now() - start,
      };
    }

    // tier1.outcome === 'unhandled' → Tier 3 dilemma.
    // When Tier 1 cannot resolve the merge (both sides modified the same
    // region and none of the strategies apply), Sharp emits a structured
    // dilemma rather than delegating to git. This matches whitepaper §6.5:
    // the git-merge shim was Phase 13.13 scaffolding; the real behaviour is
    // Tier 3 escalation when Tier 1 + Tier 2 exhaust without resolution.
    return {
      outcome: 'dilemma',
      reason:
        tier1.reason ?? 'both branches modified the same region; no Tier 1 strategy resolved it',
      durationMs: performance.now() - start,
    };
  } catch (e) {
    return {
      outcome: 'error',
      reason: `sharp lane crashed: ${(e as Error).message}`,
      durationMs: performance.now() - start,
    };
  }
}

function refNameFor(scenario: Scenario, kind: string): string {
  // Per-scenario ref namespace so concurrent runs against the same Sharp
  // server don't collide. The `id` already has slashes — escape them.
  const safe = scenario.id.replaceAll('/', '__');
  return `refs/heads/${safe}/${kind}`;
}

export async function teardownSharpLane(): Promise<void> {
  // The runner owns the Sharp server / Postgres lifecycle now; nothing
  // for the lane itself to tear down.
}
