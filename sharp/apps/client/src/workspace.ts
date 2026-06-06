/**
 * Working-tree primitives: walk a directory and snapshot every file as a
 * blob; recursively build a tree object representing the snapshot;
 * materialize a tree out to disk byte-for-byte.
 *
 * v1 ignores common build-output directories (`node_modules/`, `target/`,
 * `.git/`, `.sharp/`, `dist/`) on snapshot. The list is hardcoded;
 * project-level overrides are post-v1 and would slot in via a
 * `.sharpignore` file.
 */
import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
  symlink,
  readlink,
  rm,
  chmod,
} from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import {
  encodeTree,
  hashObject,
  idFromHex,
  idHex,
  type TreeEntry,
  type TreeMode,
} from '@sharp/git-canonical';
import type { SharpClient } from './http';

const IGNORED_DIRS = new Set(['.git', '.sharp', 'node_modules', 'target', 'dist', '.cargo']);

export interface SnapshotOptions {
  /** Absolute path to the working-tree root being snapshotted. */
  root: string;
}

export interface FileSnapshot {
  /** Relative path under root (forward slashes, no leading slash). */
  path: string;
  mode: TreeMode;
  blobId: Uint8Array;
}

/**
 * Walk `root`, hash every file as a blob, push blobs to the server, and
 * return the snapshot. The caller passes the resulting list to
 * `buildTreeFromSnapshot` to construct the root tree object.
 */
export async function snapshotWorkingTree(
  client: SharpClient,
  opts: SnapshotOptions,
): Promise<FileSnapshot[]> {
  const out: FileSnapshot[] = [];
  await walk(opts.root, opts.root, client, out);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

async function walk(
  root: string,
  dir: string,
  client: SharpClient,
  out: FileSnapshot[],
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, client, out);
    } else if (entry.isSymbolicLink()) {
      const target = await readlink(full);
      const buf = new Uint8Array(Buffer.from(target, 'utf8'));
      const id = await client.putObject('blob', buf);
      out.push({
        path: relative(root, full).replaceAll('\\', '/'),
        mode: '120000',
        blobId: idFromHex(id),
      });
    } else if (entry.isFile()) {
      const data = await readFile(full);
      const id = await client.putObject('blob', new Uint8Array(data));
      const s = await stat(full);
      const mode: TreeMode = s.mode & 0o111 ? '100755' : '100644';
      out.push({
        path: relative(root, full).replaceAll('\\', '/'),
        mode,
        blobId: idFromHex(id),
      });
    }
  }
}

/**
 * Recursively build tree objects from a flat snapshot. Returns the id of
 * the root tree.
 *
 * Subtrees are grouped by path prefix and emitted bottom-up; each subtree
 * is hashed via @sharp/git-canonical and pushed to the server CAS.
 */
export async function buildTreeFromSnapshot(
  client: SharpClient,
  files: readonly FileSnapshot[],
): Promise<string> {
  return buildSubtree(client, files, '');
}

async function buildSubtree(
  client: SharpClient,
  files: readonly FileSnapshot[],
  prefix: string,
): Promise<string> {
  // Partition `files` by the segment immediately after `prefix`.
  // - file directly under prefix → leaf entry (blob/symlink)
  // - file deeper under prefix → recurse into child subtree by name
  const childFiles: TreeEntry[] = [];
  const subPaths = new Map<string, FileSnapshot[]>();
  for (const f of files) {
    const tail = prefix ? f.path.slice(prefix.length + 1) : f.path;
    const slash = tail.indexOf('/');
    if (slash < 0) {
      childFiles.push({ mode: f.mode, name: tail, id: f.blobId });
    } else {
      const head = tail.slice(0, slash);
      const arr = subPaths.get(head) ?? [];
      arr.push(f);
      subPaths.set(head, arr);
    }
  }

  // Build subtrees bottom-up.
  for (const [name, subFiles] of subPaths) {
    const subPrefix = prefix ? `${prefix}/${name}` : name;
    const subTreeId = await buildSubtree(client, subFiles, subPrefix);
    childFiles.push({ mode: '40000', name, id: idFromHex(subTreeId) });
  }

  const bytes = encodeTree(childFiles, 'sha1');
  // Local hash for the return; server's putObject will recompute and
  // confirm.
  const localId = idHex(hashObject('tree', bytes, 'sha1'));
  await client.putObject('tree', bytes, 'sha1');
  return localId;
}

// ---------------------------------------------------------------------------
// Materialization (the inverse direction)
// ---------------------------------------------------------------------------

/**
 * Materialize a tree onto the filesystem at `dest`. Removes anything
 * under `dest` first (except .sharp/), so the working tree exactly
 * matches the tree's contents.
 */
export async function materializeTree(
  client: SharpClient,
  rootTreeId: string,
  dest: string,
): Promise<void> {
  await clearWorkingTree(dest);
  await materializeRecursive(client, rootTreeId, dest);
}

async function clearWorkingTree(dest: string): Promise<void> {
  for (const entry of await readdir(dest, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === '.sharp' || entry.name === '.git') continue;
    await rm(resolve(dest, entry.name), { recursive: true, force: true });
  }
}

async function materializeRecursive(
  client: SharpClient,
  treeId: string,
  dest: string,
): Promise<void> {
  const rec = await client.getObject(treeId);
  if (rec.kind !== 'tree') throw new Error(`expected tree, got ${rec.kind}`);
  const { decodeTree } = await import('@sharp/git-canonical');
  const entries = decodeTree(rec.data, 'sha1');
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const path = join(dest, entry.name);
    const idHexStr = idHex(entry.id);
    if (entry.mode === '40000') {
      await materializeRecursive(client, idHexStr, path);
    } else if (entry.mode === '120000') {
      const blob = await client.getObject(idHexStr);
      await mkdir(dirname(path), { recursive: true });
      await symlink(Buffer.from(blob.data).toString('utf8'), path);
    } else if (entry.mode === '160000') {
      // Submodule gitlink — preserve as an empty directory in v1; no
      // recursive ingest. See whitepaper §7.1.
      await mkdir(path, { recursive: true });
    } else {
      const blob = await client.getObject(idHexStr);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, blob.data);
      if (entry.mode === '100755') await chmod(path, 0o755);
    }
  }
}
