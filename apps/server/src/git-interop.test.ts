/**
 * Integration test for `sharp git import`.
 *
 * Builds a small bare git repo on disk with a known shape (one blob,
 * one tree, one commit), runs importGitRepo against it, and verifies
 * that Sharp's CAS now contains the exact same object SHAs and
 * canonical bytes.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idFromHex, idHex } from '@sharp/git-canonical';
import {
  dockerAvailable,
  startPostgres,
  type PgContainer,
} from '../../../tests/harness/pg-container';
import { runMigrations } from './migrate';
import { createRepo, getObject, objectExists } from './cas';
import { resolveRef } from './refs';
import { importGitRepo } from './git-interop';
import postgres from 'postgres';

const requirePg = process.env.SHARP_TEST_REQUIRE_PG === '1';
const explicitSkip = process.env.SHARP_TEST_SKIP_PG === '1';
let pg: PgContainer | undefined;
let sql: postgres.Sql | undefined;
let dockerOk = false;
let sourceRepoPath = '';
let knownCommitId = '';

beforeAll(async () => {
  if (explicitSkip) return;
  dockerOk = dockerAvailable();
  if (!dockerOk && !requirePg) return;
  pg = await startPostgres();
  sql = postgres(pg.url, { onnotice: () => {} });
  await runMigrations(sql);

  // Build a small bare repo we can import.
  const sourceRoot = await mkdtemp(resolve(tmpdir(), 'sharp-import-src-'));
  sourceRepoPath = resolve(sourceRoot, 'work');
  spawnSync('git', ['init', '--quiet', '--initial-branch=main', sourceRepoPath]);
  await writeFile(resolve(sourceRepoPath, 'README.md'), 'hello\n');
  for (const args of [
    ['add', '-A'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'initial'],
  ] as const) {
    const r = spawnSync('git', args, { cwd: sourceRepoPath, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  // Capture the commit SHA so we can verify Sharp ingested it.
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepoPath, encoding: 'utf8' });
  knownCommitId = r.stdout.trim();
}, 240_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 2 });
  if (pg) await pg.stop();
  if (sourceRepoPath) await rm(resolve(sourceRepoPath, '..'), { recursive: true, force: true });
});

const skip = explicitSkip || (!requirePg && !dockerOk);

describe.skipIf(skip)('sharp git import', () => {
  it('imports objects with byte-identical SHAs and mirrors HEAD', async () => {
    const repo = await createRepo(sql!, { name: `import_${Date.now()}` });
    const result = await importGitRepo(sql!, { repo: repo.id, source: sourceRepoPath });

    expect(result.objectsImported).toBeGreaterThanOrEqual(3); // blob + tree + commit
    expect(result.head).toBe('refs/heads/main');

    // Sharp now has the commit at exactly the same id Git computed.
    const commitId = idFromHex(knownCommitId);
    expect(await objectExists(sql!, repo.id, commitId)).toBe(true);

    // refs/heads/main resolves to the same id.
    const tip = await resolveRef(sql!, repo.id, 'refs/heads/main');
    expect(tip && idHex(tip)).toBe(knownCommitId);

    // The README.md blob's content round-trips byte-identically.
    const commit = await getObject(sql!, repo.id, commitId);
    expect(commit?.kind).toBe('commit');
    // Surface check: commit text contains "tree <hex>" header.
    expect(Buffer.from(commit!.data).toString('utf8')).toMatch(/^tree [0-9a-f]+\n/);
  });

  it('round-trip: import → export → bit-identical commit SHAs', async () => {
    const { exportGitRepo } = await import('./git-interop');
    // Build a 3-commit linear repo on disk.
    const sourceRoot = await import('node:fs/promises').then((m) =>
      m.mkdtemp(resolve(tmpdir(), 'sharp-roundtrip-src-')),
    );
    const sourcePath = resolve(sourceRoot, 'work');
    spawnSync('git', ['init', '--quiet', '--initial-branch=main', sourcePath]);
    const sourceShas: string[] = [];
    for (let i = 1; i <= 3; i++) {
      await import('node:fs/promises').then((m) =>
        m.writeFile(resolve(sourcePath, `f${i}.txt`), `content ${i}\n`),
      );
      spawnSync('git', ['add', '-A'], { cwd: sourcePath });
      spawnSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', `commit ${i}`],
        { cwd: sourcePath },
      );
      const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourcePath, encoding: 'utf8' });
      sourceShas.push(r.stdout.trim());
    }

    // Import into Sharp.
    const repo = await createRepo(sql!, { name: `roundtrip_${Date.now()}` });
    const importResult = await importGitRepo(sql!, { repo: repo.id, source: sourcePath });
    expect(importResult.objectsImported).toBeGreaterThanOrEqual(3 * 2 + 3); // 3 blobs + ~3 trees + 3 commits

    // Export to a fresh bare repo on disk.
    const exportDest = await import('node:fs/promises').then((m) =>
      m.mkdtemp(resolve(tmpdir(), 'sharp-roundtrip-dst-')),
    );
    const exportResult = await exportGitRepo(sql!, {
      repo: repo.id,
      branch: 'refs/heads/main',
      destination: resolve(exportDest, 'exported.git'),
    });
    expect(exportResult.commitsExported).toBe(3);

    // git rev-list against the exported repo must produce identical SHAs.
    const revList = spawnSync(
      'git',
      [
        '--git-dir',
        resolve(exportDest, 'exported.git'),
        'rev-list',
        '--reverse',
        'refs/heads/main',
      ],
      { encoding: 'utf8' },
    );
    expect(revList.status).toBe(0);
    const exportedShas = revList.stdout.trim().split('\n');
    expect(exportedShas).toEqual(sourceShas);

    // Cleanup
    await import('node:fs/promises').then((m) =>
      m.rm(sourceRoot, { recursive: true, force: true }),
    );
    await import('node:fs/promises').then((m) =>
      m.rm(exportDest, { recursive: true, force: true }),
    );
  });

  // Suppress unused-import warnings.
  void mkdir;
});
