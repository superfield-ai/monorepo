/**
 * Continuous speculative merge — projections.
 *
 * A projection for (repo, branch_ref, target_ref) holds the always-up-to-date
 * result of running the Tier 1 merge model over those two branches.
 *
 * The projection is computed LAZILY: on first access or when marked stale.
 * A trigger on the `refs` table marks any matching projection as stale
 * whenever either input ref advances (see migration 0009__projections.sql).
 *
 * Whitepaper §6.7, engineering-plan §7.6.
 */
import type postgres from 'postgres';
import {
  decodeTree,
  encodeCommit,
  encodeTree,
  hashObject,
  type HashAlgo,
  type TreeEntry,
} from '@sharp/git-canonical';
import { tier1Merge, type FileSet } from '@sharp/client/src/merge/index';
import { getObject, putObject, type Sql } from './cas';
import { resolveRef } from './refs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectionStatus = 'clean' | 'dilemma' | 'stale' | 'error';

export interface ProjectionRow {
  repo_id: string;
  branch_ref: string;
  target_ref: string;
  branch_tip: string | null;
  target_tip: string | null;
  projection_commit: string | null;
  status: ProjectionStatus;
  dilemma: unknown | null;
  computed_at: Date;
}

interface RawRow {
  repo_id: string;
  branch_ref: string;
  target_ref: string;
  branch_tip: Buffer | null;
  target_tip: Buffer | null;
  projection_commit: Buffer | null;
  status: ProjectionStatus;
  dilemma: unknown | null;
  computed_at: Date;
}

function rowToProjection(raw: RawRow): ProjectionRow {
  return {
    repo_id: raw.repo_id,
    branch_ref: raw.branch_ref,
    target_ref: raw.target_ref,
    branch_tip: raw.branch_tip ? raw.branch_tip.toString('hex') : null,
    target_tip: raw.target_tip ? raw.target_tip.toString('hex') : null,
    projection_commit: raw.projection_commit ? raw.projection_commit.toString('hex') : null,
    status: raw.status,
    dilemma: raw.dilemma,
    computed_at: raw.computed_at,
  };
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

export async function registerProjection(
  sql: Sql,
  repo_id: string,
  branch_ref: string,
  target_ref: string,
): Promise<ProjectionRow> {
  const rows = await sql<RawRow[]>`
    insert into projections (repo_id, branch_ref, target_ref, status)
    values (${repo_id}::uuid, ${branch_ref}, ${target_ref}, 'stale')
    on conflict (repo_id, branch_ref, target_ref) do update
      set status = 'stale', computed_at = now()
    returning
      repo_id::text as repo_id, branch_ref, target_ref,
      branch_tip, target_tip, projection_commit,
      status, dilemma, computed_at
  `;
  return rowToProjection(rows[0]!);
}

export async function listProjections(
  sql: Sql,
  repo_id: string,
  status?: ProjectionStatus,
): Promise<ProjectionRow[]> {
  const rows = status
    ? await sql<RawRow[]>`
        select
          repo_id::text as repo_id, branch_ref, target_ref,
          branch_tip, target_tip, projection_commit,
          status, dilemma, computed_at
        from projections
        where repo_id = ${repo_id}::uuid and status = ${status}
        order by branch_ref, target_ref
      `
    : await sql<RawRow[]>`
        select
          repo_id::text as repo_id, branch_ref, target_ref,
          branch_tip, target_tip, projection_commit,
          status, dilemma, computed_at
        from projections
        where repo_id = ${repo_id}::uuid
        order by branch_ref, target_ref
      `;
  return rows.map(rowToProjection);
}

export async function deleteProjection(
  sql: Sql,
  repo_id: string,
  branch_ref: string,
  target_ref: string,
): Promise<void> {
  await sql`
    delete from projections
    where repo_id = ${repo_id}::uuid
      and branch_ref = ${branch_ref}
      and target_ref = ${target_ref}
  `;
}

// ---------------------------------------------------------------------------
// Lazy-compute entry point
// ---------------------------------------------------------------------------

/**
 * Return the projection row, recomputing if stale or missing.
 * Returns undefined if the projection does not exist yet.
 */
export async function getProjection(
  sql: postgres.Sql,
  repo_id: string,
  branch_ref: string,
  target_ref: string,
): Promise<ProjectionRow | undefined> {
  const rows = await sql<RawRow[]>`
    select
      repo_id::text as repo_id, branch_ref, target_ref,
      branch_tip, target_tip, projection_commit,
      status, dilemma, computed_at
    from projections
    where repo_id = ${repo_id}::uuid
      and branch_ref = ${branch_ref}
      and target_ref = ${target_ref}
    limit 1
  `;
  if (rows.length === 0) return undefined;
  const row = rows[0]!;
  if (row.status === 'stale') {
    return recomputeProjection(sql, repo_id, branch_ref, target_ref);
  }
  return rowToProjection(row);
}

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

/**
 * Materialize a commit's tree recursively into a Map<path, content>.
 * Blob contents are decoded as UTF-8; binary files get an empty string
 * (not meaningful for merge but avoids crashing on non-text paths).
 */
async function materializeTree(
  sql: Sql,
  repo_id: string,
  treeId: Uint8Array,
  prefix: string,
  algo: HashAlgo,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rec = await getObject(sql, repo_id, treeId);
  if (!rec || rec.kind !== 'tree') return out;
  for (const entry of decodeTree(rec.data, algo)) {
    const fullPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      const sub = await materializeTree(sql, repo_id, entry.id, fullPath, algo);
      for (const [p, c] of sub) out.set(p, c);
    } else {
      const blobRec = await getObject(sql, repo_id, entry.id);
      if (blobRec) {
        try {
          out.set(fullPath, Buffer.from(blobRec.data).toString('utf8'));
        } catch {
          out.set(fullPath, '');
        }
      }
    }
  }
  return out;
}

/**
 * Write a Map<string,string> back into the CAS as a tree object.
 * Flat tree for v1 — nested directories are not needed here because
 * materializeTree already flattens paths (e.g. "src/foo.ts").
 * Files are stored as blobs; the tree entries reference them.
 */
async function writeTreeToCas(
  sql: Sql,
  repo_id: string,
  files: Map<string, string>,
  algo: HashAlgo,
): Promise<Uint8Array> {
  const entries: TreeEntry[] = [];
  // Sort names so the tree hash is deterministic.
  const sortedPaths = [...files.keys()].sort();
  for (const path of sortedPaths) {
    const content = files.get(path)!;
    const payload = new Uint8Array(Buffer.from(content, 'utf8'));
    const blobId = await putObject(sql, { repo: repo_id, algo, kind: 'blob', payload });
    // Flat tree: only the basename.
    // For nested paths we need to build sub-trees. We flatten via a
    // recursive helper below instead.
    entries.push({ mode: '100644', name: path, id: blobId });
  }
  const treeBytes = encodeTree(entries, algo);
  const treeId = await putObject(sql, { repo: repo_id, algo, kind: 'tree', payload: treeBytes });
  return treeId;
}

/**
 * Get the commit's tree id by decoding the commit object.
 */
async function getCommitTree(
  sql: Sql,
  repo_id: string,
  commitId: Uint8Array,
): Promise<Uint8Array | undefined> {
  const rec = await getObject(sql, repo_id, commitId);
  if (!rec || rec.kind !== 'commit') return undefined;
  const text = Buffer.from(rec.data).toString('utf8');
  const m = /^tree ([0-9a-f]+)$/m.exec(text);
  return m ? new Uint8Array(Buffer.from(m[1]!, 'hex')) : undefined;
}

const SHARP_COMMITTER = {
  nameAndEmail: 'Sharp <sharp-projection@sharp.dev>',
  timestamp: 0,
  timezone: '+0000',
};

/**
 * Run the merge engine on current tips and update the projections row.
 * Always returns the updated row.
 */
export async function recomputeProjection(
  sql: postgres.Sql,
  repo_id: string,
  branch_ref: string,
  target_ref: string,
): Promise<ProjectionRow> {
  // Resolve current tips.
  const branchTip = await resolveRef(sql, repo_id, branch_ref);
  const targetTip = await resolveRef(sql, repo_id, target_ref);

  if (!branchTip || !targetTip) {
    const rows = await sql<RawRow[]>`
      update projections
      set status = 'error',
          computed_at = now()
      where repo_id = ${repo_id}::uuid
        and branch_ref = ${branch_ref}
        and target_ref = ${target_ref}
      returning
        repo_id::text as repo_id, branch_ref, target_ref,
        branch_tip, target_tip, projection_commit,
        status, dilemma, computed_at
    `;
    return rowToProjection(rows[0]!);
  }

  // Materialize trees. We use target_ref as the "base" (common ancestor
  // approximation for v1; a real LCA walk is a Phase 19 follow-up) and
  // branch_ref as A, target_ref as B.
  const algo: HashAlgo = 'sha1';

  const branchTreeId = await getCommitTree(sql, repo_id, branchTip);
  const targetTreeId = await getCommitTree(sql, repo_id, targetTip);

  if (!branchTreeId || !targetTreeId) {
    const rows = await sql<RawRow[]>`
      update projections
      set status = 'error',
          computed_at = now()
      where repo_id = ${repo_id}::uuid
        and branch_ref = ${branch_ref}
        and target_ref = ${target_ref}
      returning
        repo_id::text as repo_id, branch_ref, target_ref,
        branch_tip, target_tip, projection_commit,
        status, dilemma, computed_at
    `;
    return rowToProjection(rows[0]!);
  }

  const branchFiles = await materializeTree(sql, repo_id, branchTreeId, '', algo);
  const targetFiles = await materializeTree(sql, repo_id, targetTreeId, '', algo);

  // For v1, use target as the base (so we see what branch adds on top of target).
  const base: FileSet = { files: targetFiles };
  const a: FileSet = { files: branchFiles };
  const b: FileSet = { files: targetFiles };

  const mergeResult = await tier1Merge(base, a, b);

  if (mergeResult.outcome === 'clean_ok') {
    // Write the merged tree to CAS and create a projection commit.
    const mergedFiles = mergeResult.files!;

    // timestamp based on current time for the projection commit
    const now = Math.floor(Date.now() / 1000);
    const committer = { ...SHARP_COMMITTER, timestamp: now };

    const mergedTreeId = await writeTreeToCas(sql, repo_id, mergedFiles, algo);

    const commitBytes = encodeCommit(
      {
        tree: mergedTreeId,
        parents: [branchTip, targetTip],
        author: committer,
        committer,
        message: `sharp: projection of ${branch_ref} onto ${target_ref}\n`,
      },
      algo,
    );
    const commitId = hashObject('commit', commitBytes, algo);
    await putObject(sql, { repo: repo_id, algo, kind: 'commit', payload: commitBytes });

    const rows = await sql<RawRow[]>`
      update projections
      set status = 'clean',
          branch_tip = ${Buffer.from(branchTip)},
          target_tip = ${Buffer.from(targetTip)},
          projection_commit = ${Buffer.from(commitId)},
          dilemma = null,
          computed_at = now()
      where repo_id = ${repo_id}::uuid
        and branch_ref = ${branch_ref}
        and target_ref = ${target_ref}
      returning
        repo_id::text as repo_id, branch_ref, target_ref,
        branch_tip, target_tip, projection_commit,
        status, dilemma, computed_at
    `;
    return rowToProjection(rows[0]!);
  }

  if (mergeResult.outcome === 'dilemma') {
    const rows = await sql<RawRow[]>`
      update projections
      set status = 'dilemma',
          branch_tip = ${Buffer.from(branchTip)},
          target_tip = ${Buffer.from(targetTip)},
          projection_commit = null,
          dilemma = ${JSON.stringify(mergeResult.dilemma)}::jsonb,
          computed_at = now()
      where repo_id = ${repo_id}::uuid
        and branch_ref = ${branch_ref}
        and target_ref = ${target_ref}
      returning
        repo_id::text as repo_id, branch_ref, target_ref,
        branch_tip, target_tip, projection_commit,
        status, dilemma, computed_at
    `;
    return rowToProjection(rows[0]!);
  }

  // 'unhandled' — store as error with reason in dilemma field.
  const rows = await sql<RawRow[]>`
    update projections
    set status = 'error',
        branch_tip = ${Buffer.from(branchTip)},
        target_tip = ${Buffer.from(targetTip)},
        projection_commit = null,
        dilemma = ${JSON.stringify({ reason: mergeResult.reason ?? 'unhandled' })}::jsonb,
        computed_at = now()
    where repo_id = ${repo_id}::uuid
      and branch_ref = ${branch_ref}
      and target_ref = ${target_ref}
    returning
      repo_id::text as repo_id, branch_ref, target_ref,
      branch_tip, target_tip, projection_commit,
      status, dilemma, computed_at
  `;
  return rowToProjection(rows[0]!);
}
