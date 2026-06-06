/**
 * Tier 1 deterministic merge with AST-aware rename propagation.
 *
 * Per docs/whitepaper.md §6.1 + §6.5 and engineering-plan §7.1: walks
 * the per-path triclass between base/A/B and emits a candidate merged
 * tree. v1's strategies:
 *
 *   1. Trivial-merge: only-one-side-modified, both-modified-identical →
 *      take the modified content (or either side).
 *   2. Rename propagation: a top-level symbol renamed in A's tree gets
 *      its references rewritten in B-only files. Closes the canonical
 *      "cross-file rename + new caller using old name" failure mode.
 *   3. Delete-edit dilemma: file deleted in A, edited in B → emit a
 *      Tier 3 dilemma rather than auto-resolve.
 *
 * Out of v1 scope (returns `unhandled` and the lane falls back to the
 * git-merge shim for now): both-sides-modified non-identical content,
 * format vs edit, whitespace vs edit, reorder additions to the same
 * region. These slot into Phase 19 follow-ups.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverHooks, runHooks } from '../hooks';
import {
  detectLanguage,
  detectRenames,
  extractSymbols,
  replaceIdentifierAst,
  type DetectedRename,
} from '../semantic/symbols';

export interface FileEntry {
  path: string;
  content: string;
}

export interface FileSet {
  /** path → content. Symlinks excluded for v1 (rare in the corpus). */
  files: Map<string, string>;
}

export interface MergeResult {
  outcome: 'clean_ok' | 'dilemma' | 'unhandled';
  files?: Map<string, string>;
  /** Set when outcome === 'dilemma'. Stable shape per whitepaper §6.5. */
  dilemma?: DilemmaPayload;
  /** Why the merge engine fell through (when outcome === 'unhandled'). */
  reason?: string;
  /** Any renames the engine detected and propagated; useful for logs. */
  renamesApplied?: DetectedRename[];
}

export interface DilemmaPayload {
  sharp_dilemma: 1;
  kind: 'dilemma';
  reason: string;
  candidates: { id: string; summary: string }[];
  involved_paths: string[];
}

export function setOf(entries: readonly FileEntry[]): FileSet {
  const map = new Map<string, string>();
  for (const e of entries) map.set(e.path, e.content);
  return { files: map };
}

/**
 * "Both pure additions" heuristic: compute an LCS-anchored merge that
 * preserves every line in `base` and inserts each side's additions at
 * the position they appear in their respective branch. Returns the
 * merged content, or undefined if either branch deleted or modified
 * any base lines.
 *
 * Algorithm:
 *   1. Diff (base → a) and (base → b) at the line level. Both diffs
 *      must consist only of insertions; any deletion or replacement
 *      bails out (returns undefined).
 *   2. Walk base; at each base-line index emit any A-side and B-side
 *      insertions whose anchor is that index (A first, then B; ordering
 *      is deterministic but unsorted across branches).
 *   3. Append insertions whose anchor is past the last base line.
 *
 * This matches Git's `merge -s recursive` behavior on the additions-
 * only case but emits no conflict markers when the two sides' additions
 * happen to be adjacent or identical (we dedup byte-identical adjacent
 * insertions to keep imports/exports tidy).
 */
export function tryConcatAdditions(base: string, a: string, b: string): string | undefined {
  const baseLines = splitLines(base);
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  const aIns = pureInsertionsOrUndefined(baseLines, aLines);
  const bIns = pureInsertionsOrUndefined(baseLines, bLines);
  if (!aIns || !bIns) return undefined;

  const out: string[] = [];
  for (let i = 0; i <= baseLines.length; i++) {
    const aHere = aIns.get(i) ?? [];
    const bHere = bIns.get(i) ?? [];
    // Block-level dedup: if A and B inserted the byte-identical block at
    // this anchor (e.g., both added the same `use` line), include it
    // once. Otherwise concatenate A's block first, then B's. We do NOT
    // dedup at the line level because that wrongly eats the second copy
    // of common boilerplate (`}\n`, blank lines, `  return ...;\n`).
    if (aHere.length > 0 && bHere.length > 0 && aHere.join('') === bHere.join('')) {
      out.push(...aHere);
    } else {
      out.push(...aHere, ...bHere);
    }
    if (i < baseLines.length) out.push(baseLines[i]!);
  }
  return out.join('');
}

/**
 * Returns B's content with A's known renames applied, but only when
 * A's edits to `path` are *fully accounted for* by those renames —
 * i.e., A's content is byte-identical to base after un-applying the
 * renames (running them in reverse). When that holds, A's diff is
 * "rename only" and merging is just "apply A's renames to B's
 * content."
 *
 * Returns undefined when A's edits include changes outside the rename.
 */
async function tryApplyRenamesToBContent(
  path: string,
  base: string,
  a: string,
  b: string,
  renames: readonly DetectedRename[],
): Promise<string | undefined> {
  if (renames.length === 0) return undefined;
  // Reverse-apply A's renames to A's content; if the result equals
  // base, A's diff was rename-only.
  let unrenamed = a;
  for (const r of renames) {
    const replaced = await replaceIdentifierAst(path, unrenamed, r.newName, r.oldName);
    unrenamed = replaced.content;
  }
  if (unrenamed !== base) return undefined;
  // Apply A's renames to B's content; that's the merged result.
  let merged = b;
  for (const r of renames) {
    const replaced = await replaceIdentifierAst(path, merged, r.oldName, r.newName);
    merged = replaced.content;
  }
  return merged;
}

/**
 * Returns the "semantic" side's content if exactly one of A/B is a
 * whitespace-equivalent reformat of base. Returns undefined when both
 * sides changed something semantic, or when neither side did.
 *
 * Equivalence is checked at the AST level (Tree-sitter parse, structural
 * comparison). Comments and string literals are part of the AST so
 * comment-only or string-only changes are NOT considered whitespace-
 * equivalent — they're real semantic edits.
 */
async function tryWhitespaceEquivalent(
  path: string,
  base: string,
  a: string,
  b: string,
): Promise<string | undefined> {
  const lang = detectLanguage(path);
  if (!lang) return undefined;
  const aIsReformat = await astEqual(lang, base, a);
  const bIsReformat = await astEqual(lang, base, b);
  if (aIsReformat && !bIsReformat) return b;
  if (bIsReformat && !aIsReformat) return a;
  return undefined;
}

/**
 * Whitespace-collapsed text equality. Two source strings are
 * "ast-equal" if their canonical token streams (everything that isn't
 * a run of whitespace between tokens) are byte-identical. We compute
 * this by parsing each side, walking the leaf tokens of the AST in
 * order, and concatenating their texts with a single space separator.
 *
 * Why parse instead of just regex-stripping whitespace? Because a
 * regex `\s+` strip would also eat whitespace *inside* string literals
 * — which would falsely declare `"hello"` and `"h ello"` equivalent.
 * The Tree-sitter parse keeps string content as a single token whose
 * `text` includes its internal whitespace.
 */
async function astEqual(language: 'ts' | 'rust', x: string, y: string): Promise<boolean> {
  if (x === y) return true;
  const xs = await tokenize(language, x);
  const ys = await tokenize(language, y);
  return xs === ys;
}

interface AstNodeShape {
  type: string;
  text: string;
  childCount: number;
  children: AstNodeShape[];
}

async function tokenize(language: 'ts' | 'rust', src: string): Promise<string> {
  const { parseFile } = await import('../semantic/parser');
  const root = (await parseFile(language, src)).root as unknown as AstNodeShape;
  const tokens: string[] = [];
  collectLeafTokens(root, tokens);
  // Trailing-comma normalization: a `,` token immediately preceding a
  // closing bracket (`)`, `]`, `}`, `>`) is syntactically optional in
  // both TypeScript and Rust. Prettier-style reformatters add it; the
  // original source may not. Drop these so a reformat-only diff that
  // adds trailing commas is recognized as whitespace-equivalent.
  return tokens
    .filter((t, i) => {
      if (t !== ',:,') return true;
      const next = tokens[i + 1];
      if (!next) return true;
      const colon = next.indexOf(':');
      const text = colon >= 0 ? next.slice(colon + 1) : next;
      return !(text === ')' || text === ']' || text === '}' || text === '>');
    })
    .join('\x00');
}

/**
 * Node types whose text content is not fully reconstructible from
 * their child tokens — Tree-sitter's Rust and TS grammars represent
 * `string_literal`, `template_string`, comments, etc. with delimiter
 * tokens as children but keep the actual content only on the parent.
 * For these we record the parent's full text and don't recurse;
 * comparisons then catch content changes inside string/template
 * literals.
 */
const ATOMIC_NODE_TYPES = new Set([
  // Rust
  'string_literal',
  'raw_string_literal',
  'char_literal',
  'byte_string_literal',
  'byte_literal',
  'integer_literal',
  'float_literal',
  'line_comment',
  'block_comment',
  // TypeScript
  'string',
  'template_string',
  'regex',
  'number',
  'comment',
  'string_fragment',
  'template_substitution',
]);

function collectLeafTokens(node: AstNodeShape, out: string[]): void {
  if (node.childCount === 0) {
    out.push(node.type + ':' + node.text);
    return;
  }
  if (ATOMIC_NODE_TYPES.has(node.type)) {
    out.push(node.type + ':' + node.text);
    return;
  }
  for (const c of node.children) collectLeafTokens(c, out);
}

/** Split keeping line terminators so we can rejoin without losing them. */
function splitLines(s: string): string[] {
  if (s === '') return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/**
 * Compute the insertions that turn `base` into `derived`, anchored at
 * the base index *after which* each block of new lines belongs. Returns
 * undefined if any base line was deleted or replaced (i.e., the diff is
 * not a pure-addition diff).
 *
 * Uses a simple two-pointer LCS-like walk: every base line must appear
 * in `derived` in order; anything in `derived` between consecutive base
 * matches is a pure insertion at that anchor.
 */
function pureInsertionsOrUndefined(
  base: readonly string[],
  derived: readonly string[],
): Map<number, string[]> | undefined {
  const insertions = new Map<number, string[]>();
  let bi = 0;
  let di = 0;
  while (bi < base.length) {
    // Find the next derived line matching base[bi].
    let dj = di;
    while (dj < derived.length && derived[dj] !== base[bi]) dj++;
    if (dj >= derived.length) {
      // base[bi] missing from derived → not pure insertion.
      return undefined;
    }
    if (dj > di) {
      const block = derived.slice(di, dj);
      const arr = insertions.get(bi) ?? [];
      arr.push(...block);
      insertions.set(bi, arr);
    }
    di = dj + 1;
    bi += 1;
  }
  if (di < derived.length) {
    const tail = derived.slice(di);
    const arr = insertions.get(base.length) ?? [];
    arr.push(...tail);
    insertions.set(base.length, arr);
  }
  return insertions;
}

/**
 * Three-way classification per path. Returns the union of paths in any
 * tree, partitioned by which side(s) modified them.
 */
type Classification =
  | { kind: 'unchanged'; content: string }
  | { kind: 'a_only'; content: string }
  | { kind: 'b_only'; content: string }
  | { kind: 'both_same'; content: string }
  | { kind: 'both_different'; a: string; b: string }
  | { kind: 'a_added'; content: string }
  | { kind: 'b_added'; content: string }
  | { kind: 'a_deleted_b_edited'; b: string }
  | { kind: 'b_deleted_a_edited'; a: string }
  | { kind: 'both_deleted' }
  | { kind: 'a_added_b_added_same'; content: string }
  | { kind: 'a_added_b_added_diff'; a: string; b: string };

function classifyPath(path: string, base: FileSet, a: FileSet, b: FileSet): Classification {
  const inB = base.files.has(path);
  const inA = a.files.has(path);
  const inAfter = b.files.has(path);
  const baseC = base.files.get(path);
  const aC = a.files.get(path);
  const bC = b.files.get(path);

  if (inB && inA && inAfter) {
    if (aC === baseC && bC === baseC) return { kind: 'unchanged', content: baseC! };
    if (aC === baseC) return { kind: 'b_only', content: bC! };
    if (bC === baseC) return { kind: 'a_only', content: aC! };
    if (aC === bC) return { kind: 'both_same', content: aC! };
    return { kind: 'both_different', a: aC!, b: bC! };
  }
  if (!inB && inA && inAfter) {
    if (aC === bC) return { kind: 'a_added_b_added_same', content: aC! };
    return { kind: 'a_added_b_added_diff', a: aC!, b: bC! };
  }
  if (!inB && inA) return { kind: 'a_added', content: aC! };
  if (!inB && inAfter) return { kind: 'b_added', content: bC! };
  if (inB && !inA && inAfter) {
    if (bC === baseC) return { kind: 'a_only', content: bC! }; // a deleted, b unchanged → take a's deletion
    return { kind: 'a_deleted_b_edited', b: bC! };
  }
  if (inB && inA && !inAfter) {
    if (aC === baseC) return { kind: 'b_only', content: aC! }; // b deleted, a unchanged → take b's deletion
    return { kind: 'b_deleted_a_edited', a: aC! };
  }
  if (inB && !inA && !inAfter) return { kind: 'both_deleted' };
  // unreachable
  throw new Error(`unreachable classify for ${path}`);
}

/**
 * Detect file-level renames in A relative to base. A file is "renamed"
 * when:
 *   - it exists in base but not in A (deleted), AND
 *   - some file exists in A but not in base (added) whose content is
 *     sufficiently similar to the deleted file's content.
 *
 * Greedy pairing: for each deleted file, pick the most-similar added
 * file above SIMILARITY_THRESHOLD that hasn't already been paired.
 * Similarity is normalized line overlap (Jaccard on line sets is the
 * v1 heuristic; AST-level similarity is a Phase 19.x refinement).
 */
function detectFileRenames(base: FileSet, a: FileSet): Map<string, string> {
  // Threshold tuned against the corpus: 0.3 catches the canonical
  // "move + small refactor" pattern (function moved to a new file,
  // body edited, comment added) without false-pairing unrelated files.
  // Anything below ~0.2 is too noisy; above ~0.5 misses moves with
  // even modest edits.
  const SIMILARITY_THRESHOLD = 0.3;
  const out = new Map<string, string>();
  const deleted: { path: string; lines: Set<string> }[] = [];
  const added: { path: string; lines: Set<string> }[] = [];
  for (const [p, c] of base.files) {
    if (!a.files.has(p)) deleted.push({ path: p, lines: lineSet(c) });
  }
  for (const [p, c] of a.files) {
    if (!base.files.has(p)) added.push({ path: p, lines: lineSet(c) });
  }
  const consumed = new Set<string>();
  for (const d of deleted) {
    let best: { path: string; sim: number } | undefined;
    for (const ad of added) {
      if (consumed.has(ad.path)) continue;
      const sim = jaccard(d.lines, ad.lines);
      if (!best || sim > best.sim) best = { path: ad.path, sim };
    }
    if (best && best.sim >= SIMILARITY_THRESHOLD) {
      out.set(d.path, best.path);
      consumed.add(best.path);
    }
  }
  return out;
}

function lineSet(content: string): Set<string> {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return new Set(lines);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Enumerate top-level renames in A relative to base, joined across files. */
async function detectRenamesAcrossTrees(base: FileSet, a: FileSet): Promise<DetectedRename[]> {
  const all: DetectedRename[] = [];
  const seen = new Set<string>();
  for (const [path, baseContent] of base.files) {
    if (!detectLanguage(path)) continue;
    if (!a.files.has(path)) continue;
    const aContent = a.files.get(path)!;
    if (aContent === baseContent) continue;
    const beforeSyms = await extractSymbols(path, baseContent);
    const afterSyms = await extractSymbols(path, aContent);
    for (const r of detectRenames(beforeSyms, afterSyms)) {
      const key = `${r.kind}:${r.oldName}->${r.newName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(r);
    }
  }
  return all;
}

/**
 * Write a Map<string, string> file tree to `dest` (created if absent).
 * Used to materialize a candidate merged tree for hook execution.
 */
async function materializeCandidateTree(dest: string, files: Map<string, string>): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const [path, content] of files) {
    const parts = path.split('/');
    if (parts.length > 1) {
      await mkdir(join(dest, ...parts.slice(0, -1)), { recursive: true });
    }
    await writeFile(join(dest, path), content, 'utf8');
  }
}

/**
 * Score a candidate merged FileSet against a set of oracle branches.
 *
 * Per whitepaper §6.4 and engineering-plan §7.3: for each oracle branch,
 * simulate a 3-way merge of (base, candidate, oracle) and count how many
 * paths would be `both_different` and un-resolvable (i.e., neither side is
 * a pure-addition nor whitespace-equivalent reformat). A lower score means
 * the candidate is more compatible with the downstream oracle branches.
 *
 * This is intentionally lightweight — the full Tier 1 pipeline is not re-run;
 * only the `classifyPath` classification is checked to identify hard conflicts.
 */
export function scoreAgainstOracles(candidate: FileSet, base: FileSet, oracles: FileSet[]): number {
  let total = 0;
  for (const oracle of oracles) {
    const allPaths = new Set<string>([
      ...base.files.keys(),
      ...candidate.files.keys(),
      ...oracle.files.keys(),
    ]);
    for (const path of allPaths) {
      const c = classifyPath(path, base, candidate, oracle);
      // `both_different` means candidate and oracle diverged on a file that
      // existed in base — a likely conflict if the oracle branch were merged.
      // `a_added_b_added_diff` means both candidate and oracle added the same
      // path with different content — also a conflict.
      if (c.kind === 'both_different' || c.kind === 'a_added_b_added_diff') {
        total++;
      }
    }
  }
  return total;
}

export async function tier1Merge(
  base: FileSet,
  a: FileSet,
  b: FileSet,
  opts?: { workspaceRoot?: string; oracleBranches?: FileSet[] },
): Promise<MergeResult> {
  const result = new Map<string, string>();
  const allPaths = new Set<string>([...base.files.keys(), ...a.files.keys(), ...b.files.keys()]);

  // Detect renames in A vs base; these will drive propagation into B-only files.
  const renames = await detectRenamesAcrossTrees(base, a);
  const renamesApplied: DetectedRename[] = [];
  const dilemmaPaths: string[] = [];
  let unhandled: string | undefined;

  // Detect file-level renames in A vs base (path move, possibly with
  // small content edits). Maps oldPath → newPath so the
  // a_deleted_b_edited classifier can route B's edits to the new path.
  const fileRenames = detectFileRenames(base, a);
  // Track paths consumed by a file-rename redirect so we don't also
  // emit them via their 'a_added' / 'a_deleted_b_edited' classification.
  const consumedByRename = new Set<string>();

  for (const path of allPaths) {
    const c = classifyPath(path, base, a, b);
    switch (c.kind) {
      case 'unchanged':
      case 'a_only':
      case 'b_only':
      case 'both_same':
        result.set(path, c.content);
        break;
      case 'a_added':
        // File A introduced; rename propagation already happened on A's
        // own files, so we take A's content as-is — UNLESS the path is
        // the destination of a file-rename whose source B edited, in
        // which case we already wrote B's edited content there in the
        // a_deleted_b_edited branch.
        if (!consumedByRename.has(path)) result.set(path, c.content);
        break;
      case 'b_added': {
        // File B introduced. Apply A's rename(s) to it.
        let content = c.content;
        for (const r of renames) {
          const replaced = await replaceIdentifierAst(path, content, r.oldName, r.newName);
          if (replaced.changed) {
            content = replaced.content;
            if (!renamesApplied.some((x) => x.oldName === r.oldName && x.newName === r.newName)) {
              renamesApplied.push(r);
            }
          }
        }
        result.set(path, content);
        break;
      }
      case 'a_added_b_added_same':
        result.set(path, c.content);
        break;
      case 'a_added_b_added_diff':
        unhandled = unhandled ?? `both branches added ${path} with different content`;
        break;
      case 'both_different': {
        const baseContent = base.files.get(path)!;
        // Rename-only-on-A path: if A's diff vs base is fully accounted
        // for by the detected top-level renames, the merged content is
        // B's content with those renames applied — so a use-site change
        // in B's file (or a `pub use api::HttpClient;` in lib.rs) gets
        // its identifier rewritten to the new name without losing B's
        // additions.
        const renameMerged = await tryApplyRenamesToBContent(path, baseContent, c.a, c.b, renames);
        if (renameMerged !== undefined) {
          result.set(path, renameMerged);
          for (const r of renames) {
            if (!renamesApplied.some((x) => x.oldName === r.oldName && x.newName === r.newName)) {
              renamesApplied.push(r);
            }
          }
          break;
        }
        // Whitespace-equivalence: if one side's diff vs base preserves
        // the AST exactly (parse trees byte-identical when serialized
        // structurally), that side is a pure reformat and the other
        // side carries the real semantic change. Take the semantic
        // side's content. Handles format/* and whitespace_only/*.
        const equivOnly = await tryWhitespaceEquivalent(path, baseContent, c.a, c.b);
        if (equivOnly !== undefined) {
          let content = equivOnly;
          for (const r of renames) {
            const replaced = await replaceIdentifierAst(path, content, r.oldName, r.newName);
            if (replaced.changed) {
              content = replaced.content;
              if (!renamesApplied.some((x) => x.oldName === r.oldName && x.newName === r.newName)) {
                renamesApplied.push(r);
              }
            }
          }
          result.set(path, content);
          break;
        }
        // Try concat-additions: both sides only added lines (no
        // deletions), and their additions land in different regions.
        // Handles reorder/import_merge cleanly.
        const merged = tryConcatAdditions(baseContent, c.a, c.b);
        if (merged !== undefined) {
          let content = merged;
          for (const r of renames) {
            const replaced = await replaceIdentifierAst(path, content, r.oldName, r.newName);
            if (replaced.changed) {
              content = replaced.content;
              if (!renamesApplied.some((x) => x.oldName === r.oldName && x.newName === r.newName)) {
                renamesApplied.push(r);
              }
            }
          }
          result.set(path, content);
        } else {
          unhandled = unhandled ?? `both branches modified ${path}`;
        }
        break;
      }
      case 'a_deleted_b_edited': {
        // If A renamed `path` → newPath, route B's edited content to
        // newPath instead of dilemma'ing. v1 takes B's content
        // verbatim; refining A's content edits into B's (when both
        // touched the function body) is a Phase 19.x follow-up.
        const newPath = fileRenames.get(path);
        if (newPath !== undefined) {
          result.set(newPath, c.b);
          consumedByRename.add(newPath); // suppress later 'a_added' for newPath
        } else {
          dilemmaPaths.push(path);
        }
        break;
      }
      case 'b_deleted_a_edited':
        dilemmaPaths.push(path);
        break;
      case 'both_deleted':
        // Both sides agreed to delete; honor it (no entry).
        break;
    }
  }

  if (dilemmaPaths.length > 0) {
    return {
      outcome: 'dilemma',
      dilemma: {
        sharp_dilemma: 1,
        kind: 'dilemma',
        reason: 'delete-then-edit on the same path; correct policy is intent-dependent',
        candidates: [
          { id: 'keep_b_edited', summary: 'keep the edited file from B; ignore A’s deletion' },
          { id: 'apply_a_deletion', summary: 'apply A’s deletion; discard B’s edits' },
        ],
        involved_paths: dilemmaPaths,
      },
      renamesApplied,
    };
  }

  if (unhandled) {
    return { outcome: 'unhandled', reason: unhandled, renamesApplied };
  }

  // Tier 2 oracle (whitepaper §6.4, engineering-plan §7.3):
  // When Tier 1 produces multiple candidate trees, score each against the
  // provided oracle branches (other in-development branches that serve as
  // ground truth for downstream compatibility). Pick the candidate with the
  // lowest conflict score. If scores are tied, fall through to a Tier 3
  // dilemma.
  //
  // Currently Tier 1 always produces a single candidate tree, so the oracle
  // never fires. The infrastructure is here for completeness and for test
  // corpus scenarios that exercise oracle selection (fixtures with branch_c/).
  //
  // When multiple candidates exist they will be supplied as an array here;
  // for now we assert the single-candidate invariant so the oracle is a no-op.
  const candidates: Array<{ id: string; files: Map<string, string> }> = [
    { id: 'candidate_0', files: result },
  ];
  if (candidates.length > 1 && opts?.oracleBranches && opts.oracleBranches.length > 0) {
    const scored = candidates.map((cand) => ({
      cand,
      score: scoreAgainstOracles({ files: cand.files }, base, opts.oracleBranches!),
    }));
    scored.sort((x, y) => x.score - y.score);
    const best = scored[0]!;
    const second = scored[1]!;
    if (best.score < second.score) {
      // Clear winner — use it.
      result.clear();
      for (const [p, c] of best.cand.files) result.set(p, c);
    } else {
      // Tied — emit a Tier 3 dilemma.
      return {
        outcome: 'dilemma',
        dilemma: {
          sharp_dilemma: 1,
          kind: 'dilemma',
          reason:
            'Tier 2 oracle: multiple candidates tied; cannot determine correct merge automatically',
          candidates: scored.map((s) => ({
            id: s.cand.id,
            summary: `oracle conflict score: ${s.score}`,
          })),
          involved_paths: [...result.keys()],
        },
        renamesApplied,
      };
    }
  }

  // Pre-merge hooks gate (whitepaper §6.3): after Tier 1 intrinsic
  // verification produces a clean_ok candidate, run any installed
  // pre-merge hooks before Tier 2 oracle considers the tree.
  if (opts?.workspaceRoot) {
    const hookPaths = await discoverHooks(opts.workspaceRoot, 'pre-merge');
    if (hookPaths.length > 0) {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'sharp-pre-merge-'));
      try {
        await materializeCandidateTree(tmpRoot, result);
        const hookRun = await runHooks(hookPaths, {
          cwd: tmpRoot,
          context: { event: 'pre-merge', workspaceRoot: opts.workspaceRoot },
        });
        if (!hookRun.ok) {
          const failed = hookRun.results[hookRun.results.length - 1]!;
          return {
            outcome: 'dilemma',
            dilemma: {
              sharp_dilemma: 1,
              kind: 'dilemma',
              reason: `pre-merge hook vetoed the candidate tree: ${failed.hookPath} exited ${failed.timedOut ? 'timed out' : failed.exitCode}${failed.stderr ? ` — ${failed.stderr.trim()}` : ''}`,
              candidates: [
                {
                  id: 'fix_and_retry',
                  summary: 'resolve the issue the hook reported and retry the merge',
                },
                {
                  id: 'skip_hooks',
                  summary: 'retry without hooks (remove or disable the failing hook)',
                },
              ],
              involved_paths: [...result.keys()],
            },
            renamesApplied,
          };
        }
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    }
  }

  return { outcome: 'clean_ok', files: result, renamesApplied };
}
