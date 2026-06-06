/**
 * Commit creation.
 *
 * `createCommit` is the high-level operation: it verifies that the tree
 * and every parent already exist as objects in the same repo, builds the
 * canonical commit bytes, hashes and stores via the CAS, walks the
 * tree-vs-parent diff to populate `commit_paths`, and (optionally)
 * advances a ref atomically — all in one transaction.
 *
 * Lower-level callers (`sharp git import`, which receives pre-formed
 * canonical bytes) bypass `createCommit` and use `cas.putObject` directly,
 * then call `recordCommitPaths` separately.
 */
import type postgres from 'postgres';
import {
  decodeTree,
  encodeCommit,
  hashObject,
  type CommitObject,
  type HashAlgo,
} from '@sharp/git-canonical';
import { getObject, objectExists, putObject, type Sql } from './cas';

export interface CreateCommitInput {
  repo: string;
  algo: HashAlgo;
  commit: CommitObject;
  /** Optional ref to advance atomically with the commit creation. */
  refUpdate?: {
    name: string;
    expectedOld?: Uint8Array;
  };
}

export class MissingObjectError extends Error {
  constructor(
    public readonly id: Uint8Array,
    public readonly kind: string,
  ) {
    super(`missing ${kind} object: ${Buffer.from(id).toString('hex')}`);
    this.name = 'MissingObjectError';
  }
}

export async function createCommit(
  sql: postgres.Sql,
  input: CreateCommitInput,
): Promise<{ id: Uint8Array }> {
  return sql.begin(async (tx: postgres.TransactionSql) => {
    if (!(await objectExists(tx, input.repo, input.commit.tree))) {
      throw new MissingObjectError(input.commit.tree, 'tree');
    }
    for (const p of input.commit.parents) {
      if (!(await objectExists(tx, input.repo, p))) {
        throw new MissingObjectError(p, 'parent commit');
      }
    }

    const bytes = encodeCommit(input.commit, input.algo);
    const id = hashObject('commit', bytes, input.algo);
    await putObject(tx, {
      repo: input.repo,
      algo: input.algo,
      kind: 'commit',
      payload: bytes,
    });

    await recordCommitPaths(tx, input.repo, id, input.commit, input.algo);

    if (input.refUpdate) {
      await advanceRef(tx, input.repo, input.refUpdate.name, input.refUpdate.expectedOld, id);
    }

    return { id };
  });
}

/**
 * Walk the tree-vs-parents diff and write rows into `commit_paths`.
 *
 * For a no-parent commit, every path in the tree is "added".
 * For a single-parent commit, paths that differ between tree and parent's
 * tree are recorded.
 * For multi-parent (merge) commits, the union of paths-changed-vs-each-parent
 * is recorded.
 */
export async function recordCommitPaths(
  sql: Sql,
  repo: string,
  commitId: Uint8Array,
  commit: CommitObject,
  algo: HashAlgo,
): Promise<void> {
  const treePaths = await collectTreePaths(sql, repo, commit.tree, '', algo);

  let changed: Set<string>;
  if (commit.parents.length === 0) {
    changed = treePaths;
  } else {
    changed = new Set();
    for (const parentId of commit.parents) {
      const parentTree = await getParentTree(sql, repo, parentId);
      const parentPaths = parentTree
        ? await collectTreePaths(sql, repo, parentTree, '', algo)
        : new Set<string>();
      // diff(treePaths, parentPaths) — paths in either side, but with
      // different blob IDs. We recompute via a path-keyed map below.
      const treeMap = await collectTreePathMap(sql, repo, commit.tree, '', algo);
      const parentMap = parentTree
        ? await collectTreePathMap(sql, repo, parentTree, '', algo)
        : new Map<string, string>();
      for (const [path, id] of treeMap) {
        if (parentMap.get(path) !== id) changed.add(path);
      }
      for (const path of parentMap.keys()) {
        if (!treeMap.has(path)) changed.add(path);
      }
      // (also include paths from parentPaths/treePaths not yet considered —
      // already handled by the maps above)
      void parentPaths;
    }
  }

  if (changed.size === 0) return;
  const cidBuf = Buffer.from(commitId);
  for (const path of changed) {
    await sql`
      insert into commit_paths (repo_id, commit_id, path)
      values (${repo}::uuid, ${cidBuf}, ${path})
      on conflict do nothing
    `;
  }
}

async function getParentTree(
  sql: Sql,
  repo: string,
  parentId: Uint8Array,
): Promise<Uint8Array | undefined> {
  const rec = await getObject(sql, repo, parentId);
  if (!rec || rec.kind !== 'commit') return undefined;
  const text = Buffer.from(rec.data).toString('utf8');
  const m = /^tree ([0-9a-f]+)$/m.exec(text);
  return m ? new Uint8Array(Buffer.from(m[1]!, 'hex')) : undefined;
}

async function collectTreePaths(
  sql: Sql,
  repo: string,
  treeId: Uint8Array,
  prefix: string,
  algo: HashAlgo,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [path] of await collectTreePathMap(sql, repo, treeId, prefix, algo)) {
    out.add(path);
  }
  return out;
}

async function collectTreePathMap(
  sql: Sql,
  repo: string,
  treeId: Uint8Array,
  prefix: string,
  algo: HashAlgo,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rec = await getObject(sql, repo, treeId);
  if (!rec || rec.kind !== 'tree') return out;
  for (const entry of decodeTree(rec.data, algo)) {
    const fullPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      const sub = await collectTreePathMap(sql, repo, entry.id, fullPath, algo);
      for (const [p, id] of sub) out.set(p, id);
    } else {
      out.set(fullPath, Buffer.from(entry.id).toString('hex'));
    }
  }
  return out;
}

async function advanceRef(
  sql: Sql,
  repo: string,
  name: string,
  expectedOld: Uint8Array | undefined,
  newTarget: Uint8Array,
): Promise<void> {
  if (expectedOld === undefined) {
    await sql`
      insert into refs (repo_id, name, target, target_kind)
      values (${repo}::uuid, ${name}, ${Buffer.from(newTarget)}, 'hash')
    `;
  } else {
    const rows = await sql`
      update refs
         set target = ${Buffer.from(newTarget)}, updated_at = now()
       where repo_id = ${repo}::uuid
         and name = ${name}
         and target_kind = 'hash'
         and target = ${Buffer.from(expectedOld)}
       returning target
    `;
    if (rows.count === 0) throw new Error(`ref CAS failed: ${name}`);
  }
}
