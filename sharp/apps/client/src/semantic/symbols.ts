/**
 * AST-driven symbol detection and identifier rewriting.
 *
 * For TypeScript files:
 *   - extractSymbols: uses ts.createSourceFile (single-file parser) to walk
 *     the AST and extract top-level exported declarations. This is sufficient
 *     for the rename detection heuristic since we only need top-level export
 *     names from a single file.
 *   - replaceIdentifierAst: uses ts.createLanguageService with
 *     findRenameLocations() so the TS compiler correctly handles imports,
 *     re-exports, type references, JSX usage, and shorthand properties — and
 *     correctly does NOT rename string literals.
 *
 * For Rust files: uses Tree-sitter (web-tree-sitter + prebuilt WASM grammars)
 * to walk the parse tree and extract pub items. The Rust path is unchanged.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import { detectLanguage, parseFile, type Language } from './parser';

export type { Language };
export { detectLanguage };

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'struct'
  | 'trait'
  | 'mod'
  | 'struct_field'
  | 'trait_method';

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  /** Byte range of the *defining identifier* in the source. */
  start: number;
  end: number;
}

interface AstNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  childCount: number;
  children: AstNode[];
  childForFieldName(name: string): AstNode | null;
}

const RUST_DECL: Record<string, SymbolKind | undefined> = {
  function_item: 'function',
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  mod_item: 'mod',
  const_item: 'const',
  static_item: 'const',
};

function symbolFromNode(node: AstNode, kind: SymbolKind): SymbolDef | undefined {
  // Most declarations have a `name` field that is an identifier or
  // type_identifier; for variable declarations we walk to the
  // variable_declarator's name.
  let nameNode = node.childForFieldName('name');
  if (!nameNode && (node.type === 'lexical_declaration' || node.type === 'variable_declaration')) {
    const decl = node.children.find((c) => c.type === 'variable_declarator');
    nameNode = decl?.childForFieldName('name') ?? null;
  }
  if (!nameNode) return undefined;
  return {
    name: nameNode.text,
    kind,
    start: nameNode.startIndex,
    end: nameNode.endIndex,
  };
}

function isPubRust(node: AstNode): boolean {
  // Rust visibility: child node of type `visibility_modifier` whose first
  // child token is `pub`. Items without it are crate-private.
  const vis = node.children.find((c) => c.type === 'visibility_modifier');
  return vis !== undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function extractSymbolsTs(content: string): SymbolDef[] {
  const sourceFile = ts.createSourceFile('__sharp__.ts', content, ts.ScriptTarget.ESNext, true);
  const out: SymbolDef[] = [];

  for (const stmt of sourceFile.statements) {
    if (!hasExportModifier(stmt)) continue;

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: 'function',
        start: stmt.name.getStart(sourceFile, false),
        end: stmt.name.getEnd(),
      });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: 'class',
        start: stmt.name.getStart(sourceFile, false),
        end: stmt.name.getEnd(),
      });
    } else if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: 'interface',
        start: stmt.name.getStart(sourceFile, false),
        end: stmt.name.getEnd(),
      });
    } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: 'type',
        start: stmt.name.getStart(sourceFile, false),
        end: stmt.name.getEnd(),
      });
    } else if (ts.isEnumDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: 'enum',
        start: stmt.name.getStart(sourceFile, false),
        end: stmt.name.getEnd(),
      });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          out.push({
            name: decl.name.text,
            kind: 'const',
            start: decl.name.getStart(sourceFile, false),
            end: decl.name.getEnd(),
          });
        }
      }
    }
  }
  return out;
}

/**
 * Fallback identifier replacement using word-boundary regex.
 * Used when the LanguageService cannot rename (e.g., ambient contexts,
 * or the name does not appear at a renameable position).
 */
function replaceIdentifierSimple(
  content: string,
  oldName: string,
  newName: string,
): { changed: boolean; content: string } {
  const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const out = content.replace(re, newName);
  return { changed: out !== content, content: out };
}

/**
 * TypeScript identifier replacement using ts.createLanguageService and
 * findRenameLocations(). The TS compiler correctly handles:
 *   - Import specifiers (`import { foo }` → `import { bar }`)
 *   - Type references (`const x: Foo` → `const x: Bar`)
 *   - JSX element names and shorthand properties
 *   - String literals are NOT renamed (compiler knows the difference)
 *
 * Implementation note: a temporary directory is used so the LanguageService
 * can read the file from disk. The directory is cleaned up in a finally block.
 *
 * TODO: upgrade to a multi-file LanguageService that can follow cross-file
 * references when the merge engine materializes the full candidate tree to
 * disk. See findRenameLocations() — it already returns locations across all
 * files in the LanguageServiceHost's getScriptFileNames() list.
 */
function replaceIdentifierTs(
  content: string,
  oldName: string,
  newName: string,
): { changed: boolean; content: string } {
  // Fast path: bail early if the name isn't anywhere in the source text.
  const pos = content.indexOf(oldName);
  if (pos < 0) return { changed: false, content };

  const tmpDir = mkdtempSync(join(tmpdir(), 'sharp-ts-ls-'));
  const fileName = join(tmpDir, 'file.ts');
  writeFileSync(fileName, content);

  try {
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [fileName],
      getScriptVersion: () => '0',
      getScriptSnapshot: (f) => {
        try {
          return ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8'));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => tmpDir,
      getCompilationSettings: () => ({
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: false,
        skipLibCheck: true,
      }),
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
    };

    const service = ts.createLanguageService(host, ts.createDocumentRegistry());

    const renameInfo = service.getRenameInfo(fileName, pos, { allowRenameOfImportPath: false });
    if (!renameInfo.canRename) {
      // LanguageService cannot rename at this position (e.g., the first
      // occurrence is inside a string or comment). Fall back to the simple
      // word-boundary regex so callers always get a best-effort result.
      return replaceIdentifierSimple(content, oldName, newName);
    }

    const locations = service.findRenameLocations(fileName, pos, false, false, undefined);
    if (!locations || locations.length === 0) return { changed: false, content };

    // Apply replacements right-to-left to preserve earlier offsets.
    const spans = locations
      .filter((l) => l.fileName === fileName)
      .map((l) => ({ start: l.textSpan.start, end: l.textSpan.start + l.textSpan.length }))
      .sort((a, b) => b.start - a.start);

    let out = content;
    for (const span of spans) {
      out = out.slice(0, span.start) + newName + out.slice(span.end);
    }
    return { changed: out !== content, content: out };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function rustPubItems(root: AstNode): SymbolDef[] {
  const out: SymbolDef[] = [];
  function walk(node: AstNode): void {
    const kind = RUST_DECL[node.type];
    if (kind && isPubRust(node)) {
      const sym = symbolFromNode(node, kind);
      if (sym) out.push(sym);

      // For pub structs: extract pub fields from field_declaration_list
      if (node.type === 'struct_item') {
        const fieldList = node.children.find((c) => c.type === 'field_declaration_list');
        if (fieldList) {
          for (const field of fieldList.children) {
            if (field.type === 'field_declaration' && isPubRust(field)) {
              const nameNode = field.children.find((c) => c.type === 'field_identifier');
              if (nameNode) {
                out.push({
                  name: nameNode.text,
                  kind: 'struct_field',
                  start: nameNode.startIndex,
                  end: nameNode.endIndex,
                });
              }
            }
          }
        }
      }

      // For pub traits: extract method signatures from declaration_list
      if (node.type === 'trait_item') {
        const declList = node.children.find((c) => c.type === 'declaration_list');
        if (declList) {
          for (const item of declList.children) {
            if (item.type === 'function_signature_item') {
              const nameNode = item.children.find((c) => c.type === 'identifier');
              if (nameNode) {
                out.push({
                  name: nameNode.text,
                  kind: 'trait_method',
                  start: nameNode.startIndex,
                  end: nameNode.endIndex,
                });
              }
            }
          }
        }
      }
    }
    for (const c of node.children) walk(c);
  }
  walk(root);
  return out;
}

export async function extractSymbols(path: string, content: string): Promise<SymbolDef[]> {
  const language = detectLanguage(path);
  if (!language) return [];
  if (language === 'ts') return extractSymbolsTs(content);
  const parsed = await parseFile(language, content);
  return rustPubItems(parsed.root as unknown as AstNode);
}

export interface DetectedRename {
  oldName: string;
  newName: string;
  kind: SymbolKind;
}

/**
 * Heuristic rename detection by kind: a name in `before` not in `after`
 * paired with a name in `after` not in `before`, when there's exactly
 * one of each per kind, is a rename. Anything ambiguous → no rename.
 */
export function detectRenames(before: SymbolDef[], after: SymbolDef[]): DetectedRename[] {
  const byKindBefore = new Map<SymbolKind, string[]>();
  const byKindAfter = new Map<SymbolKind, string[]>();
  for (const s of before) {
    const arr = byKindBefore.get(s.kind) ?? [];
    arr.push(s.name);
    byKindBefore.set(s.kind, arr);
  }
  for (const s of after) {
    const arr = byKindAfter.get(s.kind) ?? [];
    arr.push(s.name);
    byKindAfter.set(s.kind, arr);
  }
  const out: DetectedRename[] = [];
  for (const [kind, beforeNames] of byKindBefore) {
    const afterNames = byKindAfter.get(kind) ?? [];
    const removed = beforeNames.filter((n) => !afterNames.includes(n));
    const added = afterNames.filter((n) => !beforeNames.includes(n));
    if (removed.length === 1 && added.length === 1) {
      out.push({ oldName: removed[0]!, newName: added[0]!, kind });
    }
  }
  return out;
}

/**
 * AST-driven identifier replacement: walks the parse tree and rewrites
 * every `identifier` / `type_identifier` whose text matches `oldName` to
 * `newName`. Comments and string literals are skipped automatically
 * because they parse to non-identifier node kinds.
 */
export async function replaceIdentifierAst(
  path: string,
  content: string,
  oldName: string,
  newName: string,
): Promise<{ changed: boolean; content: string }> {
  const language = detectLanguage(path);
  if (!language) return { changed: false, content };
  if (language === 'ts') return replaceIdentifierTs(content, oldName, newName);
  const parsed = await parseFile(language, content);
  const ranges: { start: number; end: number }[] = [];
  function walk(node: AstNode): void {
    if (
      (node.type === 'identifier' ||
        node.type === 'type_identifier' ||
        node.type === 'shorthand_property_identifier' ||
        node.type === 'shorthand_property_identifier_pattern' ||
        node.type === 'property_identifier' ||
        node.type === 'field_identifier' ||
        node.type === 'shorthand_field_identifier') &&
      node.text === oldName
    ) {
      ranges.push({ start: node.startIndex, end: node.endIndex });
      return;
    }
    for (const c of node.children) walk(c);
  }
  walk(parsed.root as unknown as AstNode);

  if (ranges.length === 0) return { changed: false, content };
  // Apply replacements right-to-left so earlier offsets stay valid.
  ranges.sort((a, b) => b.start - a.start);
  let out = content;
  for (const r of ranges) {
    out = out.slice(0, r.start) + newName + out.slice(r.end);
  }
  return { changed: true, content: out };
}
