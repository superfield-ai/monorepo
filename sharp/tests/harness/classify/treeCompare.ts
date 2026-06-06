/**
 * Recursive tree compare.
 *
 * Compares two directory trees byte-for-byte, ignoring the `.git/` directory
 * (the lane's working tree contains git metadata that is not part of the
 * scenario's expected output) and any `node_modules/` produced by stock
 * validator wrappers.
 *
 * Returns either `equal: true` or a structured diff with the first
 * differing path. We don't return *every* difference — the first one is
 * enough signal to fail a scenario, and the failure-artifact writer can
 * dump both trees for human inspection.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'target', '.cargo']);

export type TreeDiff =
  | { equal: true }
  | { equal: false; kind: 'missing-in-actual'; path: string }
  | { equal: false; kind: 'extra-in-actual'; path: string }
  | {
      equal: false;
      kind: 'type-mismatch';
      path: string;
      expected: 'file' | 'dir';
      actual: 'file' | 'dir';
    }
  | { equal: false; kind: 'content-mismatch'; path: string };

async function listChildren(dir: string): Promise<Map<string, 'file' | 'dir'>> {
  const out = new Map<string, 'file' | 'dir'>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      out.set(entry.name, 'dir');
    } else if (entry.isFile()) {
      out.set(entry.name, 'file');
    } else if (entry.isSymbolicLink()) {
      // Treat symlinks as files for comparison purposes — Tree-sitter and
      // the merge model don't traverse them and the source tree of a
      // fixture should not include them in the seed corpus anyway.
      out.set(entry.name, 'file');
    }
  }
  return out;
}

async function compareFiles(expected: string, actual: string): Promise<boolean> {
  const [a, b] = await Promise.all([readFile(expected), readFile(actual)]);
  return a.equals(b);
}

export async function compareTrees(expected: string, actual: string, rel = ''): Promise<TreeDiff> {
  let expectedKind: 'file' | 'dir';
  let actualKind: 'file' | 'dir';
  try {
    const s = await stat(expected);
    expectedKind = s.isDirectory() ? 'dir' : 'file';
  } catch {
    return { equal: false, kind: 'missing-in-actual', path: rel || '/' };
  }
  try {
    const s = await stat(actual);
    actualKind = s.isDirectory() ? 'dir' : 'file';
  } catch {
    return { equal: false, kind: 'missing-in-actual', path: rel || '/' };
  }
  if (expectedKind !== actualKind) {
    return {
      equal: false,
      kind: 'type-mismatch',
      path: rel || '/',
      expected: expectedKind,
      actual: actualKind,
    };
  }

  if (expectedKind === 'file') {
    const equal = await compareFiles(expected, actual);
    return equal ? { equal: true } : { equal: false, kind: 'content-mismatch', path: rel || '/' };
  }

  const [expectedChildren, actualChildren] = await Promise.all([
    listChildren(expected),
    listChildren(actual),
  ]);

  // Sort for determinism so the "first differing path" is stable across runs.
  const allNames = [...new Set([...expectedChildren.keys(), ...actualChildren.keys()])].sort();
  for (const name of allNames) {
    const childRel = rel ? `${rel}/${name}` : name;
    const e = expectedChildren.get(name);
    const a = actualChildren.get(name);
    if (e && !a) {
      return { equal: false, kind: 'missing-in-actual', path: childRel };
    }
    if (!e && a) {
      return { equal: false, kind: 'extra-in-actual', path: childRel };
    }
    const diff = await compareTrees(join(expected, name), join(actual, name), childRel);
    if (!diff.equal) return diff;
  }
  return { equal: true };
}

export function describeTreeDiff(diff: TreeDiff): string {
  if (diff.equal) return 'equal';
  switch (diff.kind) {
    case 'missing-in-actual':
      return `missing in actual: ${diff.path}`;
    case 'extra-in-actual':
      return `extra in actual: ${diff.path}`;
    case 'type-mismatch':
      return `type mismatch at ${diff.path}: expected ${diff.expected}, got ${diff.actual}`;
    case 'content-mismatch':
      return `content differs: ${diff.path}`;
  }
}

/** Helper for writing the path produced by {@link compareTrees} relative to a base. */
export function relativeFrom(base: string, p: string): string {
  return relative(base, p);
}
