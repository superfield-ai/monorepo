/**
 * tsserver-bridge — JSON-RPC 2.0 stdio server wrapping the TypeScript
 * LanguageService (via `tsserver`) for use by the Rust semantic merge host.
 *
 * # Protocol
 *
 * The bridge reads newline-delimited JSON-RPC 2.0 requests on **stdin** and
 * writes newline-delimited JSON-RPC 2.0 responses on **stdout**.  stderr is
 * reserved for diagnostic logging.
 *
 * Each request line:
 *   {"jsonrpc":"2.0","id":<n>,"method":"<method>","params":{...}}
 *
 * Each response line:
 *   {"jsonrpc":"2.0","id":<n>,"result":{...}}          // success
 *   {"jsonrpc":"2.0","id":<n>,"error":{"code":<n>,"message":"..."}}  // failure
 *
 * # Methods
 *
 * ## analyze
 *
 * Detect renamed top-level symbols between two versions of a TypeScript file.
 *
 * Request params:
 *   {
 *     "file_path": "<absolute path used as identifier>",
 *     "base_content": "<source text of the base version>",
 *     "new_content":  "<source text of the new (renamed) version>"
 *   }
 *
 * Response result:
 *   {
 *     "renames": [
 *       { "old_name": "Foo", "new_name": "Bar", "kind": "function" },
 *       ...
 *     ]
 *   }
 *
 * ## apply
 *
 * Apply a list of renames (produced by `analyze`) to a target file's content,
 * using the TypeScript LanguageService's `findRenameLocations` to correctly
 * rewrite identifiers without touching string literals or comments.
 *
 * Request params:
 *   {
 *     "file_path": "<absolute path used as identifier>",
 *     "content":   "<source text to rewrite>",
 *     "renames": [
 *       { "old_name": "Foo", "new_name": "Bar" },
 *       ...
 *     ]
 *   }
 *
 * Response result:
 *   {
 *     "content": "<rewritten source text>",
 *     "changed": true
 *   }
 *
 * ## shutdown
 *
 * Gracefully stop the bridge.  The bridge sends a success response and exits.
 *
 * Request params: {} (ignored)
 *
 * §architecture.md — Sharp subsystem (tsserver-bridge IPC protocol)
 */

import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as ts from "typescript";

// ── JSON-RPC 2.0 types ──────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// Standard JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ── Domain types ────────────────────────────────────────────────────────────

interface DetectedRename {
  old_name: string;
  new_name: string;
  kind: string;
}

type SymbolKind =
  "function" | "class" | "interface" | "type" | "enum" | "const";

interface SymbolDef {
  name: string;
  kind: SymbolKind;
  start: number;
}

// ── TypeScript LanguageService helpers ──────────────────────────────────────

/**
 * Extract exported top-level symbol names from a TypeScript source string.
 * Uses the single-file parser (no project context needed).
 */
function extractExportedSymbols(content: string): SymbolDef[] {
  const sourceFile = ts.createSourceFile(
    "__bridge__.ts",
    content,
    ts.ScriptTarget.ESNext,
    true,
  );
  const out: SymbolDef[] = [];

  for (const stmt of sourceFile.statements) {
    const hasExport =
      ts.canHaveModifiers(stmt) &&
      (ts.getModifiers(stmt) ?? []).some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
    if (!hasExport) continue;

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: "function",
        start: stmt.name.getStart(sourceFile, false),
      });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: "class",
        start: stmt.name.getStart(sourceFile, false),
      });
    } else if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: "interface",
        start: stmt.name.getStart(sourceFile, false),
      });
    } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: "type",
        start: stmt.name.getStart(sourceFile, false),
      });
    } else if (ts.isEnumDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text,
        kind: "enum",
        start: stmt.name.getStart(sourceFile, false),
      });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          out.push({
            name: decl.name.text,
            kind: "const",
            start: decl.name.getStart(sourceFile, false),
          });
        }
      }
    }
  }
  return out;
}

/**
 * Heuristic rename detection: match symbols that disappeared from `before`
 * against symbols that appeared in `after` by kind, when the count per kind
 * is unambiguous (exactly one removed, one added).
 */
function detectRenames(
  before: SymbolDef[],
  after: SymbolDef[],
): DetectedRename[] {
  const byKindBefore = new Map<string, string[]>();
  const byKindAfter = new Map<string, string[]>();

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
      out.push({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length checked above
        old_name: removed[0]!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length checked above
        new_name: added[0]!,
        kind,
      });
    }
  }
  return out;
}

/**
 * Apply identifier renames to `content` using the TypeScript LanguageService.
 * Each rename uses `findRenameLocations()` so that only true identifier
 * occurrences are rewritten — string literals and comments are preserved.
 *
 * If the LanguageService cannot rename at a position (e.g., an ambient context),
 * falls back to whole-word regex replacement.
 */
function applyRenames(
  content: string,
  renames: Array<{ old_name: string; new_name: string }>,
): { content: string; changed: boolean } {
  if (renames.length === 0) return { content, changed: false };

  let current = content;
  let anyChanged = false;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sharp-bridge-"));
  const fileName = path.join(tmpDir, "file.ts");

  try {
    for (const rename of renames) {
      const pos = current.indexOf(rename.old_name);
      if (pos < 0) continue;

      fs.writeFileSync(fileName, current, "utf8");

      const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => [fileName],
        getScriptVersion: () => "0",
        getScriptSnapshot: (f) => {
          try {
            return ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8"));
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

      const service = ts.createLanguageService(
        host,
        ts.createDocumentRegistry(),
      );

      const renameInfo = service.getRenameInfo(fileName, pos, {
        allowRenameOfImportPath: false,
      });

      let updated: string;
      if (renameInfo.canRename) {
        const locations = service.findRenameLocations(
          fileName,
          pos,
          false,
          false,
          undefined,
        );
        if (locations && locations.length > 0) {
          const spans = locations
            .filter((l) => l.fileName === fileName)
            .map((l) => ({
              start: l.textSpan.start,
              end: l.textSpan.start + l.textSpan.length,
            }))
            .sort((a, b) => b.start - a.start);

          updated = current;
          for (const span of spans) {
            updated =
              updated.slice(0, span.start) +
              rename.new_name +
              updated.slice(span.end);
          }
        } else {
          updated = current;
        }
      } else {
        // Fallback: whole-word regex replacement.
        const re = new RegExp(
          `\\b${rename.old_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "g",
        );
        updated = current.replace(re, rename.new_name);
      }

      if (updated !== current) {
        anyChanged = true;
        current = updated;
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { content: current, changed: anyChanged };
}

// ── Method handlers ─────────────────────────────────────────────────────────

function handleAnalyze(params: unknown): unknown {
  if (
    typeof params !== "object" ||
    params === null ||
    !("base_content" in params) ||
    !("new_content" in params)
  ) {
    throw {
      code: INVALID_PARAMS,
      message: "analyze requires base_content and new_content",
    };
  }

  const { base_content, new_content } = params as {
    base_content: string;
    new_content: string;
  };

  if (typeof base_content !== "string" || typeof new_content !== "string") {
    throw {
      code: INVALID_PARAMS,
      message: "base_content and new_content must be strings",
    };
  }

  const before = extractExportedSymbols(base_content);
  const after = extractExportedSymbols(new_content);
  const renames = detectRenames(before, after);

  return { renames };
}

function handleApply(params: unknown): unknown {
  if (
    typeof params !== "object" ||
    params === null ||
    !("content" in params) ||
    !("renames" in params)
  ) {
    throw {
      code: INVALID_PARAMS,
      message: "apply requires content and renames",
    };
  }

  const { content, renames } = params as {
    content: string;
    renames: Array<{ old_name: string; new_name: string }>;
  };

  if (typeof content !== "string") {
    throw { code: INVALID_PARAMS, message: "content must be a string" };
  }
  if (!Array.isArray(renames)) {
    throw { code: INVALID_PARAMS, message: "renames must be an array" };
  }

  const result = applyRenames(content, renames);
  return { content: result.content, changed: result.changed };
}

// ── Main loop ───────────────────────────────────────────────────────────────

function sendResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function processRequest(line: string): boolean {
  let req: JsonRpcRequest;

  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch {
    sendResponse({
      jsonrpc: "2.0",
      id: null,
      error: { code: PARSE_ERROR, message: "Parse error" },
    });
    return true;
  }

  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    sendResponse({
      jsonrpc: "2.0",
      id: req.id ?? null,
      error: { code: INVALID_REQUEST, message: "Invalid Request" },
    });
    return true;
  }

  if (req.method === "shutdown") {
    sendResponse({ jsonrpc: "2.0", id: req.id, result: {} });
    return false; // signal exit
  }

  try {
    let result: unknown;
    if (req.method === "analyze") {
      result = handleAnalyze(req.params);
    } else if (req.method === "apply") {
      result = handleApply(req.params);
    } else {
      sendResponse({
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: METHOD_NOT_FOUND,
          message: `Method not found: ${req.method}`,
        },
      });
      return true;
    }

    sendResponse({ jsonrpc: "2.0", id: req.id, result });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      "message" in err
    ) {
      sendResponse({
        jsonrpc: "2.0",
        id: req.id,
        error: err as { code: number; message: string },
      });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tsserver-bridge] internal error: ${msg}\n`);
      sendResponse({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: INTERNAL_ERROR, message: msg },
      });
    }
  }

  return true;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cont = processRequest(trimmed);
    if (!cont) break;
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[tsserver-bridge] fatal: ${err}\n`);
  process.exit(1);
});
