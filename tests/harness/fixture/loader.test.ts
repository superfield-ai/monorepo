import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureError, loadScenario } from './loader';

let TMP_ROOT: string;

async function writeFixture(
  category: string,
  language: string,
  name: string,
  meta: string,
  opts: { withBaseDir?: boolean; withBranchA?: boolean; withBranchB?: boolean } = {},
): Promise<string> {
  const path = resolve(TMP_ROOT, category, language, name);
  await mkdir(path, { recursive: true });
  await writeFile(resolve(path, 'meta.yaml'), meta);
  if (opts.withBaseDir !== false) await mkdir(resolve(path, 'base'), { recursive: true });
  if (opts.withBranchA !== false) await mkdir(resolve(path, 'branch_a'), { recursive: true });
  if (opts.withBranchB !== false) await mkdir(resolve(path, 'branch_b'), { recursive: true });
  return path;
}

beforeAll(async () => {
  TMP_ROOT = await mkdtemp(resolve(tmpdir(), 'sharp-loader-test-'));
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe('fixture loader', () => {
  it('loads a well-formed fixture', async () => {
    const path = await writeFixture(
      'refactor',
      'ts',
      'happy_path',
      `name: happy_path
category: refactor
language: ts
summary: a smoke fixture
expected_git_outcome: conflict
expected_sharp_outcome: clean_ok
`,
    );
    const s = await loadScenario(path);
    expect(s.id).toBe('refactor/ts/happy_path');
    expect(s.meta.summary).toBe('a smoke fixture');
    expect(s.expectedPath).toBeUndefined();
    expect(s.validatorPath).toBeUndefined();
    expect(s.oracleBranchPaths).toEqual([]);
  });

  it('rejects malformed yaml', async () => {
    const path = await writeFixture('refactor', 'ts', 'bad_yaml', 'this: is: not: valid: yaml: [');
    await expect(loadScenario(path)).rejects.toBeInstanceOf(FixtureError);
  });

  it('rejects schema violations', async () => {
    const path = await writeFixture(
      'refactor',
      'ts',
      'bad_schema',
      `name: bad_schema
category: refactor
language: ts
summary: missing outcome fields
`,
    );
    await expect(loadScenario(path)).rejects.toThrow(/schema/);
  });

  it('rejects missing required directories', async () => {
    const path = await writeFixture(
      'refactor',
      'ts',
      'no_base',
      `name: no_base
category: refactor
language: ts
summary: no base dir
expected_git_outcome: conflict
expected_sharp_outcome: clean_ok
`,
      { withBaseDir: false },
    );
    await expect(loadScenario(path)).rejects.toThrow(/base/);
  });

  it('rejects layout/meta disagreement', async () => {
    const path = await writeFixture(
      'refactor',
      'ts',
      'mismatched',
      `name: mismatched
category: reorder
language: ts
summary: meta says reorder but path says refactor
expected_git_outcome: conflict
expected_sharp_outcome: clean_ok
`,
    );
    await expect(loadScenario(path)).rejects.toThrow(/category/);
  });

  it('discovers oracle branches', async () => {
    const path = await writeFixture(
      'refactor',
      'ts',
      'with_oracles',
      `name: with_oracles
category: refactor
language: ts
summary: has branch_c and branch_d
expected_git_outcome: conflict
expected_sharp_outcome: clean_ok
`,
    );
    await mkdir(resolve(path, 'branch_c'), { recursive: true });
    await mkdir(resolve(path, 'branch_d'), { recursive: true });
    const s = await loadScenario(path);
    expect(s.oracleBranchPaths.map((p) => p.split('/').at(-1))).toEqual(['branch_c', 'branch_d']);
  });

  it('detects optional expected/ and resolves stock TS validator', async () => {
    const path = await writeFixture(
      'refactor',
      'ts',
      'with_extras',
      `name: with_extras
category: refactor
language: ts
summary: has expected and stock validator
expected_git_outcome: conflict
expected_sharp_outcome: clean_ok
validator: ts
`,
    );
    await mkdir(resolve(path, 'expected'), { recursive: true });
    const s = await loadScenario(path);
    expect(s.expectedPath).toBeDefined();
    expect(s.validatorPath).toMatch(/tests\/validators\/ts\.ts$/);
  });

  it('resolves a fixture-local validator path', async () => {
    const path = await writeFixture(
      'refactor',
      'ts',
      'local_validator',
      `name: local_validator
category: refactor
language: ts
summary: ships its own validator.ts
expected_git_outcome: conflict
expected_sharp_outcome: clean_ok
validator: ./validator.ts
`,
    );
    await writeFile(resolve(path, 'validator.ts'), 'process.exit(0);\n');
    const s = await loadScenario(path);
    expect(s.validatorPath).toBe(resolve(path, 'validator.ts'));
  });

  it('rejects fixture-local validator that does not exist', async () => {
    const path = await writeFixture(
      'refactor',
      'ts',
      'missing_validator',
      `name: missing_validator
category: refactor
language: ts
summary: references a validator that is not on disk
expected_git_outcome: conflict
expected_sharp_outcome: clean_ok
validator: ./not-here.ts
`,
    );
    await expect(loadScenario(path)).rejects.toThrow(/validator path/);
  });
});
