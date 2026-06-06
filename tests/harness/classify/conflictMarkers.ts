/**
 * Detect git-style conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in
 * any file inside a tree.
 *
 * A clean merge that nonetheless leaves conflict markers in the working
 * tree should not be classified as `clean_ok`. This catches the
 * pathological "merge tool said success but the markers are still there"
 * case which `git status --porcelain` won't always surface.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'target', '.cargo']);
const MARKER_RE = /^(<{7}|={7}|>{7}) /m;

export async function hasConflictMarkers(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (await hasConflictMarkers(join(dir, entry.name))) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    const s = await stat(path);
    // Conflict markers only appear in text files; skip large binaries.
    if (s.size > 4 * 1024 * 1024) continue;
    const buf = await readFile(path);
    // Don't try to parse binary files as utf-8 — we only care about textual
    // marker lines, and those will appear in any sane text encoding.
    if (buf.includes(0)) continue;
    if (MARKER_RE.test(buf.toString('utf8'))) return true;
  }
  return false;
}
