/**
 * Bench: commit throughput
 *
 * Creates 1000 sequential commits, each with one blob and one tree, and
 * measures per-commit latency (p50, p95, p99).
 *
 * Threshold (from v1-plan §3): p99 < 50ms (warn, don't fail).
 */
import type postgres from 'postgres';
import { encodeTree } from '@sharp/git-canonical';
import { createRepo, putObject } from '../src/cas';
import { createCommit } from '../src/commit';

const COMMIT_COUNT = 1000;
const PERSON = {
  nameAndEmail: 'Bench Bot <bench@sharp.dev>',
  timestamp: 1735689600,
  timezone: '+0000',
};

export interface CommitThroughputResult {
  suite: 'commit-throughput';
  commitCount: number;
  p50ms: number;
  p95ms: number;
  p99ms: number;
  thresholdP99Ms: number;
  pass: boolean;
}

export async function runCommitThroughput(sql: postgres.Sql): Promise<CommitThroughputResult> {
  const repo = await createRepo(sql, { name: `bench_commit_${Date.now()}_${Math.random()}` });

  const latencies: number[] = [];
  let prevCommitId: Uint8Array | undefined;

  for (let i = 0; i < COMMIT_COUNT; i++) {
    const blobPayload = new Uint8Array(Buffer.from(`file content for commit ${i}\n`, 'utf8'));
    const blobId = await putObject(sql, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'blob',
      payload: blobPayload,
    });

    const treeBytes = encodeTree([{ mode: '100644', name: 'file.txt', id: blobId }]);
    const treeId = await putObject(sql, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'tree',
      payload: treeBytes,
    });

    const t0 = performance.now();
    const result = await createCommit(sql, {
      repo: repo.id,
      algo: 'sha1',
      commit: {
        tree: treeId,
        parents: prevCommitId ? [prevCommitId] : [],
        author: { ...PERSON, timestamp: PERSON.timestamp + i },
        committer: { ...PERSON, timestamp: PERSON.timestamp + i },
        message: `commit ${i}\n`,
      },
    });
    const t1 = performance.now();

    latencies.push(t1 - t0);
    prevCommitId = result.id;
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(COMMIT_COUNT * 0.5)]!;
  const p95 = latencies[Math.floor(COMMIT_COUNT * 0.95)]!;
  const p99 = latencies[Math.floor(COMMIT_COUNT * 0.99)]!;
  const THRESHOLD_P99 = 50;

  return {
    suite: 'commit-throughput',
    commitCount: COMMIT_COUNT,
    p50ms: Math.round(p50 * 100) / 100,
    p95ms: Math.round(p95 * 100) / 100,
    p99ms: Math.round(p99 * 100) / 100,
    thresholdP99Ms: THRESHOLD_P99,
    pass: p99 < THRESHOLD_P99,
  };
}
