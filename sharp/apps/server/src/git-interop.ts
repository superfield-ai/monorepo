/**
 * Git interoperability — import and export.
 *
 * Per whitepaper §7: import shells out to stock `git` for the network
 * + pack work and walks the resulting object database into Sharp's
 * CAS, preserving canonical bytes byte-for-byte. Export builds a
 * fresh bare repo on disk, materializes Sharp's objects in canonical
 * loose form, and `git push`-es to the destination — every commit on
 * the exported linear branch is byte-identical to what Sharp stored.
 *
 * v1 scope is bounded: import preserves the full DAG (multi-parent
 * commits, annotated tags, signed-commit signatures); export is
 * linear-only and refuses non-linear histories. Submodule recursion
 * and Git LFS object fetch are explicit punts (whitepaper §7.1).
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { hashObject, idHex, type ObjectKind, type HashAlgo } from '@sharp/git-canonical';
import { putObject } from './cas';
import { createRef, updateSymbolicRef } from './refs';

export interface ImportInput {
  repo: string; // repo uuid
  /** Source: a URL `git clone` understands, or a local path to a bare repo. */
  source: string;
  /** Hash algorithm for new objects. v1 default: sha1 (matching Git default). */
  algo?: HashAlgo;
}

export interface ImportResult {
  objectsImported: number;
  refsImported: number;
  head: string | undefined;
  warnings: string[];
}

/**
 * Walk a bare Git repo's object database and ingest every reachable
 * object into Sharp's CAS. Refs (heads, tags) are mirrored. HEAD's
 * symbolic target is preserved. Annotated tag objects are stored with
 * kind='tag'.
 *
 * The implementation deliberately uses `git cat-file --batch-all-objects`
 * (one-shot) for object ingest and `git for-each-ref` for ref ingest —
 * both are stable Git porcelain commands that avoid reimplementing the
 * pack format.
 */
export async function importGitRepo(sql: postgres.Sql, input: ImportInput): Promise<ImportResult> {
  const algo = input.algo ?? 'sha1';
  const warnings: string[] = [];
  const tmpRoot = await mkdtemp(resolve(tmpdir(), 'sharp-git-import-'));
  const mirror = resolve(tmpRoot, 'mirror.git');
  try {
    // 1. Mirror clone (or open existing bare repo).
    const cloneResult = spawnSync('git', ['clone', '--mirror', '--quiet', input.source, mirror], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (cloneResult.status !== 0) {
      throw new Error(`git clone --mirror failed: ${cloneResult.stderr}`);
    }

    // 2. Walk every object in the database. For each, read its kind and
    // canonical payload via `git cat-file`, then store via Sharp CAS.
    const listObjects = spawnSync(
      'git',
      [
        '--git-dir',
        mirror,
        'cat-file',
        '--batch-check=%(objectname) %(objecttype)',
        '--batch-all-objects',
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    if (listObjects.status !== 0) {
      throw new Error(`git cat-file --batch-all-objects failed: ${listObjects.stderr}`);
    }

    const ids = listObjects.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    let objectsImported = 0;
    for (const line of ids) {
      const [hex, kind] = line.split(' ');
      if (!hex || !kind) continue;
      if (kind !== 'blob' && kind !== 'tree' && kind !== 'commit' && kind !== 'tag') {
        warnings.push(`unsupported object kind ${kind} for ${hex}; skipping`);
        continue;
      }
      const cat = spawnSync('git', ['--git-dir', mirror, 'cat-file', kind, hex], {
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
      });
      if (cat.status !== 0) {
        warnings.push(`cat-file failed for ${hex}: ${cat.stderr.toString('utf8')}`);
        continue;
      }
      const payload = new Uint8Array(cat.stdout);
      // Sanity check: Sharp's hash must match Git's.
      const computed = idHex(hashObject(kind as ObjectKind, payload, algo));
      if (computed !== hex) {
        warnings.push(`hash mismatch on ${hex}: Sharp computed ${computed}; skipping`);
        continue;
      }
      await putObject(sql, { repo: input.repo, algo, kind: kind as ObjectKind, payload });
      objectsImported++;
    }

    // 3. Mirror refs.
    const forEachRef = spawnSync(
      'git',
      ['--git-dir', mirror, 'for-each-ref', '--format=%(refname) %(objectname)'],
      { encoding: 'utf8' },
    );
    if (forEachRef.status !== 0) {
      throw new Error(`git for-each-ref failed: ${forEachRef.stderr}`);
    }
    let refsImported = 0;
    for (const line of forEachRef.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      const [name, hex] = line.split(' ');
      if (!name || !hex) continue;
      try {
        await createRef(sql, input.repo, name, {
          kind: 'hash',
          target: new Uint8Array(Buffer.from(hex, 'hex')),
        });
        refsImported++;
      } catch (e) {
        warnings.push(`ref ${name} → ${hex}: ${(e as Error).message}`);
      }
    }

    // 4. HEAD: read the symbolic target and mirror it.
    const headFile = await readFile(join(mirror, 'HEAD'), 'utf8');
    const symMatch = /^ref:\s+(\S+)/.exec(headFile.trim());
    let head: string | undefined;
    if (symMatch) {
      await updateSymbolicRef(sql, input.repo, 'HEAD', symMatch[1]!);
      head = symMatch[1];
    } else {
      // Detached HEAD on a bare clone is unusual but handle it.
      const detached = headFile.trim();
      if (/^[0-9a-f]+$/.test(detached)) {
        await createRef(sql, input.repo, 'HEAD', {
          kind: 'hash',
          target: new Uint8Array(Buffer.from(detached, 'hex')),
        });
        head = detached;
      }
    }

    return { objectsImported, refsImported, head, warnings };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Walk a Sharp branch tip's parent chain. If the entire history is
 * linear (every commit has at most one parent), returns the ordered
 * list of commit ids from oldest to newest. Returns undefined when a
 * merge commit is encountered — non-linear export is out of scope for
 * v1 (whitepaper §7.2).
 */
export async function linearHistoryOrUndefined(
  sql: postgres.Sql,
  repo: string,
  tip: Uint8Array,
): Promise<Uint8Array[] | undefined> {
  const { decodeCommit } = await import('@sharp/git-canonical');
  const { getObject } = await import('./cas');
  const out: Uint8Array[] = [];
  let cur: Uint8Array | undefined = tip;
  const seen = new Set<string>();
  while (cur) {
    const hex = idHex(cur);
    if (seen.has(hex)) return undefined; // cycle (shouldn't happen)
    seen.add(hex);
    const rec = await getObject(sql, repo, cur);
    if (!rec || rec.kind !== 'commit') return undefined;
    const c = decodeCommit(rec.data);
    if (c.parents.length > 1) return undefined; // merge commit
    out.unshift(cur);
    cur = c.parents[0];
  }
  return out;
}

/**
 * Export a linear Sharp branch as a stock Git bare repository on disk.
 * Returns the path to the bare repo. Optionally `git push`-es to a
 * destination URL for distribution.
 *
 * Implementation strategy (engineering-plan §8.2):
 *   1. Verify the branch is linear via linearHistoryOrUndefined.
 *   2. Materialize a fresh `git init --bare` directory.
 *   3. Walk the linear history; for each reachable object (commit,
 *      tree, blob, tag) write its zlib-deflated form to
 *      objects/<aa>/<rest>. Sharp's IDs are Git's IDs, so the SHA in
 *      the path matches what `git fsck` will compute.
 *   4. Write the ref pointing at the tip.
 *   5. Optionally `git push` to the destination.
 */
export interface ExportInput {
  repo: string;
  /** Refname to export, e.g. 'refs/heads/main'. */
  branch: string;
  /**
   * Destination. For v1: a local directory path (Sharp creates a bare
   * repo there). The 10-repo round-trip suite uses file:// — v2 may
   * also support push to a remote URL.
   */
  destination: string;
}

export interface ExportResult {
  commitsExported: number;
  objectsExported: number;
  destination: string;
  warnings: string[];
}

export async function exportGitRepo(sql: postgres.Sql, input: ExportInput): Promise<ExportResult> {
  const { deflateSync } = await import('node:zlib');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { resolveRef } = await import('./refs');
  const { getObject, listObjects } = await import('./cas');

  const warnings: string[] = [];

  // 1. Resolve the branch to a tip commit.
  const tip = await resolveRef(sql, input.repo, input.branch);
  if (!tip) throw new Error(`ref ${input.branch} not found`);

  // 2. Verify linearity.
  const history = await linearHistoryOrUndefined(sql, input.repo, tip);
  if (!history) {
    throw new Error(
      `${input.branch} is not linear; sharp git export refuses non-linear histories per whitepaper §7.2`,
    );
  }

  // 3. Initialize a bare repo at the destination.
  const initResult = spawnSync('git', ['init', '--bare', '--quiet', input.destination], {
    encoding: 'utf8',
  });
  if (initResult.status !== 0) {
    throw new Error(`git init --bare failed: ${initResult.stderr}`);
  }

  // 4. Walk every object reachable from the branch and write loose
  //    objects to objects/<aa>/<rest>. v1 takes the simple path of
  //    exporting *every* object Sharp has for the repo; a future
  //    refinement walks the reachability set from the tip only.
  let objectsExported = 0;
  for await (const { id } of listObjects(sql, input.repo)) {
    const rec = await getObject(sql, input.repo, id);
    if (!rec) continue;
    const hex = idHex(id);
    const dir = resolve(input.destination, 'objects', hex.slice(0, 2));
    const file = resolve(dir, hex.slice(2));
    await mkdir(dir, { recursive: true });
    // Git stores objects as zlib-deflated `<kind> <size>\0<payload>`.
    const header = Buffer.from(`${rec.kind} ${rec.data.length}\0`, 'utf8');
    const deflated = deflateSync(Buffer.concat([header, Buffer.from(rec.data)]));
    await writeFile(file, deflated);
    objectsExported++;
  }

  // 5. Write the ref.
  const refPath = resolve(input.destination, input.branch);
  await mkdir(resolve(refPath, '..'), { recursive: true });
  await writeFile(refPath, idHex(tip) + '\n');

  // 6. Update HEAD to point at this branch (so `git clone` picks it up).
  await writeFile(resolve(input.destination, 'HEAD'), `ref: ${input.branch}\n`);

  // 7. Verify with `git fsck` that we produced a valid repo.
  const fsckResult = spawnSync('git', ['--git-dir', input.destination, 'fsck', '--no-dangling'], {
    encoding: 'utf8',
  });
  if (fsckResult.status !== 0) {
    warnings.push(`git fsck reported issues: ${fsckResult.stderr}`);
  }

  return {
    commitsExported: history.length,
    objectsExported,
    destination: input.destination,
    warnings,
  };
}
