/**
 * Git-canonical object encoding and decoding.
 *
 * Sharp stores object payloads in their *inflated* canonical form — the bytes
 * Git would compute its content-addressed hash over. This package owns the
 * encoding rules so server CAS, client commit-builder, and Git import/export
 * all share one source of truth.
 *
 * The canonical form Sharp hashes is:
 *   <kind> <decimal-size>\0<payload>
 *
 * Where <payload> is one of:
 *   - blob:    file contents verbatim
 *   - tree:    sorted entry list, each `<mode> <name>\0<id-binary>`
 *   - commit:  header lines + blank + message
 *   - tag:     header lines + blank + message
 *
 * Tree-entry sort is the famous "directory-sort" quirk: entries are sorted
 * bytewise *as if every directory entry had a trailing `/`*, so `foo` (a
 * directory) sorts after `foo.txt` (a file). Tests cover this.
 */

import { createHash } from 'node:crypto';

export type ObjectKind = 'blob' | 'tree' | 'commit' | 'tag';

export type HashAlgo = 'sha1' | 'sha256';

const HASH_LEN: Record<HashAlgo, number> = { sha1: 20, sha256: 32 };

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/** Compute the Git object ID for canonical-form bytes. */
export function hashObject(
  kind: ObjectKind,
  payload: Uint8Array,
  algo: HashAlgo = 'sha1',
): Uint8Array {
  const header = Buffer.from(`${kind} ${payload.length}\0`, 'utf8');
  const h = createHash(algo === 'sha1' ? 'sha1' : 'sha256');
  h.update(header);
  h.update(payload);
  return new Uint8Array(h.digest());
}

export function idHex(id: Uint8Array): string {
  return Buffer.from(id).toString('hex');
}

export function idFromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function idEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Tree entries
// ---------------------------------------------------------------------------

/** Git tree-entry modes. Stored as the exact ASCII strings Git uses. */
export type TreeMode =
  | '100644' // regular file
  | '100755' // executable file
  | '120000' // symlink
  | '160000' // gitlink (submodule)
  | '40000'; // directory (NB: NO leading zero — see Git's tree.c)

const VALID_MODES = new Set<TreeMode>(['100644', '100755', '120000', '160000', '40000']);

export interface TreeEntry {
  mode: TreeMode;
  name: string;
  id: Uint8Array;
}

/**
 * Compare two entry names per Git's tree-sort rule. Directory entries
 * (mode 40000, kind=tree, mode 160000=gitlink) sort as if their name had
 * a trailing `/`. This is what causes `foo` (dir) to sort after `foo.txt`
 * (file).
 */
function entrySortName(entry: TreeEntry): string {
  const isDirLike = entry.mode === '40000';
  return isDirLike ? entry.name + '/' : entry.name;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = entrySortName(a);
  const bn = entrySortName(b);
  // Bytewise comparison.
  const al = Buffer.from(an, 'utf8');
  const bl = Buffer.from(bn, 'utf8');
  const min = Math.min(al.length, bl.length);
  for (let i = 0; i < min; i++) {
    const av = al[i]!;
    const bv = bl[i]!;
    if (av !== bv) return av - bv;
  }
  return al.length - bl.length;
}

export function encodeTree(entries: readonly TreeEntry[], algo: HashAlgo = 'sha1'): Uint8Array {
  const sorted = [...entries].sort(compareTreeEntries);
  const hashLen = HASH_LEN[algo];
  let total = 0;
  for (const e of sorted) {
    if (!VALID_MODES.has(e.mode)) throw new Error(`invalid tree-entry mode: ${e.mode}`);
    if (e.id.length !== hashLen) {
      throw new Error(
        `tree-entry id length ${e.id.length} does not match algo ${algo} (expected ${hashLen})`,
      );
    }
    if (e.name.includes('\0') || e.name.includes('/')) {
      throw new Error(`invalid tree-entry name: ${JSON.stringify(e.name)}`);
    }
    total += e.mode.length + 1 + Buffer.byteLength(e.name, 'utf8') + 1 + hashLen;
  }
  const out = Buffer.alloc(total);
  let off = 0;
  for (const e of sorted) {
    off += out.write(`${e.mode} ${e.name}`, off, 'utf8');
    out.writeUInt8(0, off);
    off += 1;
    Buffer.from(e.id).copy(out, off);
    off += hashLen;
  }
  return new Uint8Array(out);
}

export function decodeTree(payload: Uint8Array, algo: HashAlgo = 'sha1'): TreeEntry[] {
  const hashLen = HASH_LEN[algo];
  const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < buf.length) {
    const nul = buf.indexOf(0, off);
    if (nul < 0) throw new Error('decodeTree: missing null terminator');
    const header = buf.subarray(off, nul).toString('utf8');
    const space = header.indexOf(' ');
    if (space < 0) throw new Error('decodeTree: missing space in header');
    const mode = header.slice(0, space) as TreeMode;
    if (!VALID_MODES.has(mode)) throw new Error(`decodeTree: invalid mode ${mode}`);
    const name = header.slice(space + 1);
    if (nul + 1 + hashLen > buf.length) throw new Error('decodeTree: truncated id');
    const id = new Uint8Array(buf.subarray(nul + 1, nul + 1 + hashLen));
    out.push({ mode, name, id });
    off = nul + 1 + hashLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitPerson {
  /** "Name <email>" without the timestamp/timezone. */
  nameAndEmail: string;
  /** Unix epoch seconds. */
  timestamp: number;
  /** ±HHMM, e.g. "-0500", "+0000". */
  timezone: string;
}

export interface CommitObject {
  tree: Uint8Array;
  parents: Uint8Array[];
  author: CommitPerson;
  committer: CommitPerson;
  /**
   * Optional headers preserved verbatim. Includes `gpgsig`, `mergetag`,
   * `encoding`, and any other extension headers Git produces. Each entry
   * is a single header line (key, value with embedded newlines per Git's
   * folding rules) stored as { name, value }.
   */
  extraHeaders?: { name: string; value: string }[];
  message: string;
}

function encodePerson(p: CommitPerson): string {
  return `${p.nameAndEmail} ${p.timestamp} ${p.timezone}`;
}

function parsePerson(s: string): CommitPerson {
  // Format: "Name <email> <unix-ts> <tz>". Extract the last two whitespace-
  // separated tokens as timestamp and timezone; everything else is the
  // name+email (which may contain spaces).
  const lastSp = s.lastIndexOf(' ');
  const tz = s.slice(lastSp + 1);
  const tsAndRest = s.slice(0, lastSp);
  const tsSp = tsAndRest.lastIndexOf(' ');
  const ts = Number(tsAndRest.slice(tsSp + 1));
  const nameAndEmail = tsAndRest.slice(0, tsSp);
  return { nameAndEmail, timestamp: ts, timezone: tz };
}

/** Fold a multi-line header value per Git's rules: continuation lines are prefixed with a single space. */
function foldHeaderValue(value: string): string {
  return value.replaceAll('\n', '\n ');
}

function unfoldHeaderValue(value: string): string {
  return value.replaceAll('\n ', '\n');
}

export function encodeCommit(c: CommitObject, algo: HashAlgo = 'sha1'): Uint8Array {
  const hashLen = HASH_LEN[algo];
  if (c.tree.length !== hashLen) throw new Error('encodeCommit: tree id length mismatch');
  for (const p of c.parents) {
    if (p.length !== hashLen) throw new Error('encodeCommit: parent id length mismatch');
  }
  const lines: string[] = [];
  lines.push(`tree ${idHex(c.tree)}`);
  for (const p of c.parents) lines.push(`parent ${idHex(p)}`);
  lines.push(`author ${encodePerson(c.author)}`);
  lines.push(`committer ${encodePerson(c.committer)}`);
  for (const h of c.extraHeaders ?? []) {
    lines.push(`${h.name} ${foldHeaderValue(h.value)}`);
  }
  lines.push(''); // blank line separating headers from message
  // Message goes verbatim — including its own trailing newline if any.
  return new Uint8Array(Buffer.from(lines.join('\n') + '\n' + c.message, 'utf8'));
}

export function decodeCommit(payload: Uint8Array): CommitObject {
  const text = Buffer.from(payload).toString('utf8');
  // Locate the blank line separating headers from message.
  const idx = text.indexOf('\n\n');
  if (idx < 0) throw new Error('decodeCommit: missing blank-line separator');
  const headerBlock = text.slice(0, idx);
  const message = text.slice(idx + 2);

  const headers: { name: string; value: string }[] = [];
  let cur: { name: string; value: string } | undefined;
  for (const line of headerBlock.split('\n')) {
    if (line.startsWith(' ')) {
      // continuation
      if (!cur) throw new Error('decodeCommit: continuation line without preceding header');
      cur.value += '\n' + line.slice(1);
    } else {
      if (cur) headers.push(cur);
      const sp = line.indexOf(' ');
      if (sp < 0) throw new Error(`decodeCommit: malformed header: ${JSON.stringify(line)}`);
      cur = { name: line.slice(0, sp), value: line.slice(sp + 1) };
    }
  }
  if (cur) headers.push(cur);

  let tree: Uint8Array | undefined;
  const parents: Uint8Array[] = [];
  let author: CommitPerson | undefined;
  let committer: CommitPerson | undefined;
  const extraHeaders: { name: string; value: string }[] = [];
  for (const h of headers) {
    switch (h.name) {
      case 'tree':
        tree = idFromHex(h.value);
        break;
      case 'parent':
        parents.push(idFromHex(h.value));
        break;
      case 'author':
        author = parsePerson(h.value);
        break;
      case 'committer':
        committer = parsePerson(h.value);
        break;
      default:
        extraHeaders.push({ name: h.name, value: unfoldHeaderValue(h.value) });
    }
  }
  if (!tree) throw new Error('decodeCommit: missing tree header');
  if (!author) throw new Error('decodeCommit: missing author header');
  if (!committer) throw new Error('decodeCommit: missing committer header');
  return { tree, parents, author, committer, extraHeaders, message };
}

// ---------------------------------------------------------------------------
// Tag (annotated)
// ---------------------------------------------------------------------------

export interface TagObject {
  object: Uint8Array;
  type: ObjectKind;
  tag: string;
  tagger?: CommitPerson;
  message: string;
}

export function encodeTag(t: TagObject, algo: HashAlgo = 'sha1'): Uint8Array {
  if (t.object.length !== HASH_LEN[algo]) throw new Error('encodeTag: object id length mismatch');
  const lines: string[] = [];
  lines.push(`object ${idHex(t.object)}`);
  lines.push(`type ${t.type}`);
  lines.push(`tag ${t.tag}`);
  if (t.tagger) lines.push(`tagger ${encodePerson(t.tagger)}`);
  lines.push('');
  return new Uint8Array(Buffer.from(lines.join('\n') + '\n' + t.message, 'utf8'));
}

export function decodeTag(payload: Uint8Array): TagObject {
  const text = Buffer.from(payload).toString('utf8');
  const idx = text.indexOf('\n\n');
  if (idx < 0) throw new Error('decodeTag: missing blank-line separator');
  const headerBlock = text.slice(0, idx);
  const message = text.slice(idx + 2);
  let object: Uint8Array | undefined;
  let type: ObjectKind | undefined;
  let tag: string | undefined;
  let tagger: CommitPerson | undefined;
  for (const line of headerBlock.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) throw new Error('decodeTag: malformed header');
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1);
    switch (k) {
      case 'object':
        object = idFromHex(v);
        break;
      case 'type':
        type = v as ObjectKind;
        break;
      case 'tag':
        tag = v;
        break;
      case 'tagger':
        tagger = parsePerson(v);
        break;
    }
  }
  if (!object || !type || !tag) throw new Error('decodeTag: missing required header');
  return { object, type, tag, tagger, message };
}
