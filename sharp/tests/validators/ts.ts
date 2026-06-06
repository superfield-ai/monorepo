#!/usr/bin/env bun
/**
 * Stock TypeScript validator. Runs `tsc --noEmit` against the merged tree
 * in cwd. Exits 0 iff the tree typechecks.
 *
 * Used by fixtures that set `validator: ts` in meta.yaml. Custom fixtures
 * can write their own `validator.ts` and reference it via a relative path.
 *
 * Resolution order for `tsc`:
 *   1. ./node_modules/.bin/tsc in cwd (fixture-local install)
 *   2. ../../node_modules/.bin/tsc relative to this script (workspace root)
 *   3. PATH lookup (system-wide)
 */
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (!existsSync('tsconfig.json')) {
  writeFileSync(
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['**/*.ts', '**/*.tsx'],
        exclude: ['node_modules', 'dist'],
      },
      null,
      2,
    ),
  );
}

function findTsc(): string {
  const local = resolve(process.cwd(), 'node_modules/.bin/tsc');
  if (existsSync(local)) return local;
  const workspace = resolve(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'tsc');
  if (existsSync(workspace)) return workspace;
  return 'tsc';
}

const result = spawnSync(findTsc(), ['--noEmit'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
