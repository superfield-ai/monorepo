/**
 * Tree-sitter parser singleton for TypeScript and Rust.
 *
 * Uses `web-tree-sitter` (WASM) so the build doesn't require a C
 * toolchain or `node-gyp`. Grammars are loaded from the prebuilt
 * `tree-sitter-wasms` package.
 *
 * The first call to `getParser` initializes Tree-sitter; subsequent
 * calls reuse the same parser/grammar instances. Thread safety: a Bun
 * process is single-threaded for our purposes — the parser does not
 * need pooling.
 */
import { resolve } from 'node:path';

// web-tree-sitter ships as CJS; the default export is the Parser class.
// Importing dynamically keeps the WASM init off the import-time critical
// path so the server can boot without paying the cost.
type ParserModule = {
  init(): Promise<void>;
  new (): { setLanguage(lang: unknown): void; parse(src: string): { rootNode: unknown } };
  Language: { load(path: string): Promise<unknown> };
};

let parserCtor: ParserModule | undefined;
let initialized = false;
const grammars = new Map<'ts' | 'rust', unknown>();

export type Language = 'ts' | 'rust';

const WASM_DIR = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'node_modules',
  'tree-sitter-wasms',
  'out',
);

async function ensureInit(): Promise<ParserModule> {
  if (parserCtor && initialized) return parserCtor;
  const mod = (await import('web-tree-sitter')) as unknown as { default: ParserModule };
  parserCtor = mod.default;
  await parserCtor.init();
  initialized = true;
  return parserCtor;
}

async function loadGrammar(language: Language): Promise<unknown> {
  const cached = grammars.get(language);
  if (cached) return cached;
  const Parser = await ensureInit();
  const wasmPath = resolve(
    WASM_DIR,
    language === 'ts' ? 'tree-sitter-typescript.wasm' : 'tree-sitter-rust.wasm',
  );
  const lang = await Parser.Language.load(wasmPath);
  grammars.set(language, lang);
  return lang;
}

export interface Parsed {
  language: Language;
  root: unknown;
}

export async function parseFile(language: Language, content: string): Promise<Parsed> {
  const Parser = await ensureInit();
  const parser = new Parser();
  parser.setLanguage(await loadGrammar(language));
  const tree = parser.parse(content);
  return { language, root: tree.rootNode };
}

export function detectLanguage(path: string): Language | undefined {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'ts';
  if (path.endsWith('.rs')) return 'rust';
  return undefined;
}
