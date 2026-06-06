/**
 * Walks tests/scenarios/, parses every `meta.yaml`, validates against the
 * Zod schema, and returns typed `Scenario` records.
 *
 * Layout enforced:
 *   tests/scenarios/<category>/<language>/<name>/
 *     meta.yaml                  (required)
 *     base/                      (required, directory)
 *     branch_a/                  (required, directory)
 *     branch_b/                  (required, directory)
 *     expected/                  (optional)
 *     validator.ts               (optional, referenced from meta.validator)
 *     branch_c/, branch_d/, …    (optional; Tier 2 oracle branches)
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as YAML from 'yaml';
import { ScenarioMetaSchema } from './schema';
import type { Scenario, ScenarioCategory, ScenarioLanguage } from '../types';

export const SCENARIOS_ROOT = resolve(import.meta.dirname, '..', '..', 'scenarios');

export class FixtureError extends Error {
  constructor(
    public readonly fixturePath: string,
    message: string,
  ) {
    super(`${fixturePath}: ${message}`);
    this.name = 'FixtureError';
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Load a single scenario from its directory. Surfaces structural problems
 * as `FixtureError` so the loader can collect them across the whole corpus.
 */
export async function loadScenario(fixturePath: string): Promise<Scenario> {
  const metaPath = resolve(fixturePath, 'meta.yaml');
  if (!(await isFile(metaPath))) {
    throw new FixtureError(fixturePath, 'missing meta.yaml');
  }

  const raw = await readFile(metaPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    throw new FixtureError(fixturePath, `meta.yaml is not valid YAML: ${(e as Error).message}`);
  }

  const result = ScenarioMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new FixtureError(fixturePath, `meta.yaml schema: ${result.error.message}`);
  }
  const meta = result.data;

  const basePath = resolve(fixturePath, 'base');
  const branchAPath = resolve(fixturePath, 'branch_a');
  const branchBPath = resolve(fixturePath, 'branch_b');

  for (const [label, p] of [
    ['base/', basePath],
    ['branch_a/', branchAPath],
    ['branch_b/', branchBPath],
  ] as const) {
    if (!(await isDir(p))) {
      throw new FixtureError(fixturePath, `missing required directory ${label}`);
    }
  }

  const expectedPath = resolve(fixturePath, 'expected');

  // Resolve validator selector from meta.validator. Stock validators live
  // alongside the harness; fixture-local validators are resolved relative
  // to the fixture path.
  const VALIDATORS_ROOT = resolve(import.meta.dirname, '..', '..', 'validators');
  let validatorPath: string | undefined;
  if (meta.validator === 'ts') {
    validatorPath = resolve(VALIDATORS_ROOT, 'ts.ts');
  } else if (meta.validator === 'rust') {
    validatorPath = resolve(VALIDATORS_ROOT, 'rust.ts');
  } else if (typeof meta.validator === 'string') {
    validatorPath = resolve(fixturePath, meta.validator);
    if (!(await isFile(validatorPath))) {
      throw new FixtureError(fixturePath, `validator path ${meta.validator} does not exist`);
    }
  }

  // Discover oracle branches: any directory matching branch_<single-char> beyond a/b.
  const entries = await readdir(fixturePath, { withFileTypes: true });
  const oracleBranchPaths: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = /^branch_([a-z])$/.exec(e.name);
    if (!m) continue;
    const letter = m[1]!;
    if (letter === 'a' || letter === 'b') continue;
    oracleBranchPaths.push(resolve(fixturePath, e.name));
  }
  oracleBranchPaths.sort();

  // Verify the path's category and language match the meta declaration. The
  // physical layout is the source of truth for routing; meta drift is a bug.
  const segments = fixturePath.split('/');
  const categoryFromPath = segments.at(-3) as ScenarioCategory | undefined;
  const languageFromPath = segments.at(-2) as ScenarioLanguage | undefined;
  if (categoryFromPath !== meta.category) {
    throw new FixtureError(
      fixturePath,
      `meta.category=${meta.category} disagrees with directory layout (${categoryFromPath})`,
    );
  }
  if (languageFromPath !== meta.language) {
    throw new FixtureError(
      fixturePath,
      `meta.language=${meta.language} disagrees with directory layout (${languageFromPath})`,
    );
  }
  const nameFromPath = segments.at(-1);
  if (nameFromPath !== meta.name) {
    throw new FixtureError(
      fixturePath,
      `meta.name=${meta.name} disagrees with directory name (${nameFromPath})`,
    );
  }

  return {
    id: `${meta.category}/${meta.language}/${meta.name}`,
    path: fixturePath,
    meta,
    basePath,
    branchAPath,
    branchBPath,
    expectedPath: (await isDir(expectedPath)) ? expectedPath : undefined,
    validatorPath,
    oracleBranchPaths,
  };
}

/**
 * Walk SCENARIOS_ROOT and return every loadable scenario. Throws on any
 * structural error so a malformed fixture cannot silently disappear from
 * a corpus run.
 */
export async function loadAllScenarios(root: string = SCENARIOS_ROOT): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];

  if (!(await isDir(root))) {
    return scenarios;
  }

  for (const category of await readdir(root, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryPath = resolve(root, category.name);
    for (const language of await readdir(categoryPath, { withFileTypes: true })) {
      if (!language.isDirectory()) continue;
      const languagePath = resolve(categoryPath, language.name);
      for (const scenario of await readdir(languagePath, { withFileTypes: true })) {
        if (!scenario.isDirectory()) continue;
        // Skip `_` prefixed (used for smoke fixtures and disabled drafts).
        if (scenario.name.startsWith('_')) continue;
        scenarios.push(await loadScenario(resolve(languagePath, scenario.name)));
      }
    }
  }

  scenarios.sort((a, b) => a.id.localeCompare(b.id));
  return scenarios;
}
