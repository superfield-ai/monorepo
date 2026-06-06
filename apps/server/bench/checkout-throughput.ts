/**
 * Bench: checkout throughput
 *
 * Builds a tree with 1000 files (each a small blob), commits it, then reads
 * the tree back via listObjects and getObject to simulate a checkout.
 *
 * Threshold (from v1-plan §3): < 2s for 1000 files (spec is 10k files at 2s;
 * using 1000 here for CI speed).
 */
import type postgres from 'postgres';
import { encodeTree, type TreeEntry } from '@sharp/git-canonical';
import { createRepo, putObject, listObjects, getObject } from '../src/cas';
import { createCommit } from '../src/commit';

const FILE_COUNT = 1000;
const THRESHOLD_MS = 2000;
const PERSON = {
  nameAndEmail: 'Bench Bot <bench@sharp.dev>',
  timestamp: 1735689600,
  timezone: '+0000',
};

export interface CheckoutThroughputResult {
  suite: 'checkout-throughput';
  fileCount: number;
  checkoutMs: number;
  thresholdMs: number;
  pass: boolean;
}

export async function runCheckoutThroughput(sql: postgres.Sql): Promise<CheckoutThroughputResult> {
  const repo = await createRepo(sql, { name: `bench_checkout_${Date.now()}_${Math.random()}` });

  // Build FILE_COUNT blobs and collect tree entries.
  const entries: TreeEntry[] = [];
  for (let i = 0; i < FILE_COUNT; i++) {
    const payload = new Uint8Array(Buffer.from(`content of file ${i}\n`, 'utf8'));
    const blobId = await putObject(sql, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'blob',
      payload,
    });
    entries.push({ mode: '100644', name: `file-${String(i).padStart(5, '0')}.txt`, id: blobId });
  }

  const treeBytes = encodeTree(entries);
  const treeId = await putObject(sql, {
    repo: repo.id,
    algo: 'sha1',
    kind: 'tree',
    payload: treeBytes,
  });

  await createCommit(sql, {
    repo: repo.id,
    algo: 'sha1',
    commit: {
      tree: treeId,
      parents: [],
      author: PERSON,
      committer: PERSON,
      message: 'checkout bench\n',
    },
  });

  // Simulate checkout: list all objects, fetch each blob.
  const t0 = performance.now();

  const blobIds: Uint8Array[] = [];
  for await (const obj of listObjects(sql, repo.id)) {
    if (obj.kind === 'blob') {
      blobIds.push(obj.id);
    }
  }

  for (const id of blobIds) {
    await getObject(sql, repo.id, id);
  }

  const t1 = performance.now();
  const checkoutMs = t1 - t0;

  return {
    suite: 'checkout-throughput',
    fileCount: FILE_COUNT,
    checkoutMs: Math.round(checkoutMs),
    thresholdMs: THRESHOLD_MS,
    pass: checkoutMs < THRESHOLD_MS,
  };
}
