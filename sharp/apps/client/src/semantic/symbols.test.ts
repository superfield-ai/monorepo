import { describe, expect, it } from 'vitest';
import { detectRenames, extractSymbols, replaceIdentifierAst } from './symbols';

describe('extractSymbols (TypeScript)', () => {
  it('finds top-level exported declarations', async () => {
    const src = `
import { existing } from './lib';
export function computeTotal(x: number) { return x; }
export class HttpClient {}
export interface Foo { x: number }
export type Bar = string;
export const FOO = 1;
`;
    const syms = await extractSymbols('a.ts', src);
    const names = syms.map((s) => `${s.kind}:${s.name}`).sort();
    expect(names).toEqual([
      'class:HttpClient',
      'const:FOO',
      'function:computeTotal',
      'interface:Foo',
      'type:Bar',
    ]);
  });

  it('does not find non-exported declarations', async () => {
    const src = `
function privateFn() {}
class PrivateClass {}
`;
    const syms = await extractSymbols('a.ts', src);
    expect(syms).toEqual([]);
  });
});

describe('extractSymbols (Rust)', () => {
  it('finds pub items', async () => {
    const src = `
pub fn compute_total(x: i32) -> i32 { x }
pub struct HttpClient;
pub trait Endpoint {}
pub enum Status { Ok, Err }
fn private_fn() {}
struct PrivateStruct;
`;
    const syms = await extractSymbols('a.rs', src);
    const names = syms.map((s) => `${s.kind}:${s.name}`).sort();
    expect(names).toEqual([
      'enum:Status',
      'function:compute_total',
      'struct:HttpClient',
      'trait:Endpoint',
    ]);
  });

  it('detects pub struct fields', async () => {
    const src = `
pub struct Config {
    pub name: String,
    pub timeout: u64,
    hidden: bool,
}
`;
    const syms = await extractSymbols('a.rs', src);
    const fields = syms
      .filter((s) => s.kind === 'struct_field')
      .map((s) => s.name)
      .sort();
    expect(fields).toEqual(['name', 'timeout']);
  });

  it('does not extract fields from private structs', async () => {
    const src = `
struct Config {
    pub name: String,
}
`;
    const syms = await extractSymbols('a.rs', src);
    expect(syms.filter((s) => s.kind === 'struct_field')).toEqual([]);
  });

  it('detects trait method signatures', async () => {
    const src = `
pub trait Display {
    fn describe(&self) -> String;
    fn format(&self) -> String;
}
`;
    const syms = await extractSymbols('a.rs', src);
    const methods = syms
      .filter((s) => s.kind === 'trait_method')
      .map((s) => s.name)
      .sort();
    expect(methods).toEqual(['describe', 'format']);
  });

  it('does not extract methods from private traits', async () => {
    const src = `
trait Display {
    fn describe(&self) -> String;
}
`;
    const syms = await extractSymbols('a.rs', src);
    expect(syms.filter((s) => s.kind === 'trait_method')).toEqual([]);
  });
});

describe('detectRenames', () => {
  it('detects a single rename', async () => {
    const before = await extractSymbols('a.ts', 'export function computeTotal() {}');
    const after = await extractSymbols('a.ts', 'export function computeOrderTotal() {}');
    const renames = detectRenames(before, after);
    expect(renames).toEqual([
      { oldName: 'computeTotal', newName: 'computeOrderTotal', kind: 'function' },
    ]);
  });

  it('refuses to pair when multiple symbols of the same kind change', async () => {
    const before = await extractSymbols('a.ts', 'export function a() {}\nexport function b() {}');
    const after = await extractSymbols('a.ts', 'export function c() {}\nexport function d() {}');
    expect(detectRenames(before, after)).toEqual([]);
  });

  it('detects a struct field rename (name → label)', async () => {
    const before = await extractSymbols('a.rs', 'pub struct User {\n    pub name: String,\n}\n');
    const after = await extractSymbols('a.rs', 'pub struct User {\n    pub label: String,\n}\n');
    const renames = detectRenames(before, after);
    expect(renames).toContainEqual({ oldName: 'name', newName: 'label', kind: 'struct_field' });
  });

  it('detects a trait method rename (describe → display)', async () => {
    const before = await extractSymbols(
      'a.rs',
      'pub trait Describable {\n    fn describe(&self) -> String;\n}\n',
    );
    const after = await extractSymbols(
      'a.rs',
      'pub trait Describable {\n    fn display(&self) -> String;\n}\n',
    );
    const renames = detectRenames(before, after);
    expect(renames).toContainEqual({
      oldName: 'describe',
      newName: 'display',
      kind: 'trait_method',
    });
  });
});

describe('replaceIdentifierAst', () => {
  it('rewrites every identifier occurrence, skipping comments and strings', async () => {
    const src = `import { computeTotal } from './lib';
const x = computeTotal([]);
// also computeTotal in a comment — should NOT be rewritten
const s = "computeTotal in a string"; // also skipped
`;
    const r = await replaceIdentifierAst('a.ts', src, 'computeTotal', 'computeOrderTotal');
    expect(r.changed).toBe(true);
    expect(r.content).toContain("import { computeOrderTotal } from './lib'");
    expect(r.content).toContain('const x = computeOrderTotal([])');
    // Comment and string preserved.
    expect(r.content).toContain('// also computeTotal in a comment');
    expect(r.content).toContain('"computeTotal in a string"');
  });

  it('rewrites a Rust struct name across uses', async () => {
    const src = `use crate::api::HttpClient;\npub fn make() -> HttpClient { HttpClient }\n`;
    const r = await replaceIdentifierAst('a.rs', src, 'HttpClient', 'RestClient');
    expect(r.changed).toBe(true);
    expect(r.content).toContain('use crate::api::RestClient');
    expect(r.content).toContain('pub fn make() -> RestClient { RestClient }');
  });

  it('does nothing when the name is not present', async () => {
    const src = `export function foo() {}`;
    const r = await replaceIdentifierAst('a.ts', src, 'bar', 'baz');
    expect(r.changed).toBe(false);
    expect(r.content).toBe(src);
  });
});
