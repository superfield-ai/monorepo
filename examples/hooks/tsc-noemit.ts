#!/usr/bin/env bun
/**
 * Stock pre-merge hook: typecheck the merged tree with `tsc --noEmit`.
 *
 * Drop a symlink to this file at `.sharp/hooks/pre-merge/tsc-noemit.ts`
 * and `chmod +x` it. Sharp's merge engine will run it on every
 * candidate merged tree and drop candidates that don't typecheck.
 *
 * The hook is invoked with the merged tree as cwd and a JSON context
 * on stdin (currently unused; future versions may include the candidate
 * id and parent commits).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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

const r = spawnSync('tsc', ['--noEmit'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
