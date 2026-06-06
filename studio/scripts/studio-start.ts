#!/usr/bin/env bun
/**
 * studio-start — Bootstrap a studio session and start the studio server.
 *
 * Canonical spec: docs/studio-sessions.md
 *
 * This script must be run on a studio session branch
 * (studio/session-<mainHash>-<sessionId>). It is invoked via
 * `bun run studio` from the product repo root.
 *
 * Steps:
 *   1. Validate the current branch is a studio/session-* branch.
 *   2. Start an isolated Postgres container for this session.
 *   3. Create docs/studio-sessions/<branch>/changes.md and commit it.
 *   4. Write .studio state file.
 *   5. If STUDIO_EXIT_AFTER_BOOTSTRAP=1, stop the container and exit 0.
 *   6. Otherwise, keep running until interrupted (server mode, future).
 *
 * Environment variables:
 *   STUDIO_EXIT_AFTER_BOOTSTRAP  Set to "1" to exit immediately after
 *                                bootstrap (used by tests and CI).
 *   STUDIO_SKIP_PUSH             Set to "1" to skip git push after commit.
 *   STUDIO_PORT                  HTTP port for the studio server. Default: 7000.
 *   STUDIO_API_PORT              HTTP port for the studio API. Default: 31400.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

import { startPostgres } from '../../packages/db/pg-container';

// ── Constants ────────────────────────────────────────────────────────────────

const STUDIO_BRANCH_PATTERN = /^studio\/session-([^-]+)-([a-z0-9]{4})$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCurrentBranch(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    throw new Error(`Failed to get current branch: ${stderr}`);
  }
  return (result.stdout?.toString() ?? '').trim();
}

function gitCommit(cwd: string, message: string): void {
  const add = spawnSync('git', ['add', '-A'], { cwd, stdio: 'pipe' });
  if (add.status !== 0) {
    throw new Error(`git add failed: ${add.stderr?.toString() ?? ''}`);
  }

  const commit = spawnSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Studio',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'studio@example.com',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Studio',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'studio@example.com',
    },
  });
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr?.toString() ?? ''}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  // The repo root is the directory containing this submodule's parent.
  // When installed as studio/ submodule: <product-root>/studio/scripts/studio-start.ts
  // → import.meta.dir = <product-root>/studio/scripts
  // → join(import.meta.dir, '../..') = <product-root>
  //
  // When run directly from calypso-studio repo root:
  // → import.meta.dir = <calypso-studio>/studio/scripts
  // → join(import.meta.dir, '../..') = <calypso-studio>
  const REPO_ROOT = join(import.meta.dir, '../..');

  const EXIT_AFTER_BOOTSTRAP = process.env.STUDIO_EXIT_AFTER_BOOTSTRAP === '1';
  const SKIP_PUSH = process.env.STUDIO_SKIP_PUSH === '1';

  // 1. Validate current branch.
  const currentBranch = getCurrentBranch(REPO_ROOT);
  const match = STUDIO_BRANCH_PATTERN.exec(currentBranch);
  if (!match) {
    process.stderr.write(
      `Studio requires a branch named studio/session-<hash>-<id>.\n` +
        `Current branch: ${currentBranch}\n`,
    );
    process.exit(1);
  }

  const sessionId = match[2];

  console.log(`\n  Studio session: ${sessionId}`);
  console.log(`  Branch:         ${currentBranch}\n`);

  // 2. Start Postgres container.
  console.log('  Starting database...');
  const pg = await startPostgres();
  console.log(`  Database ready:  ${pg.url}`);

  const cleanup = async (): Promise<void> => {
    await pg.stop();
  };

  // Register cleanup on process exit.
  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  // 3. Create session documentation and commit.
  const changesDir = join(REPO_ROOT, 'docs', 'studio-sessions', currentBranch);
  if (!existsSync(changesDir)) {
    mkdirSync(changesDir, { recursive: true });
  }

  const changesPath = join(changesDir, 'changes.md');
  if (!existsSync(changesPath)) {
    writeFileSync(changesPath, `# Studio Session — ${currentBranch}\n\nChanges made in this session.\n`);
  }

  gitCommit(REPO_ROOT, `studio: start session ${sessionId}`);

  if (!SKIP_PUSH) {
    const push = spawnSync('git', ['push', '--set-upstream', 'origin', currentBranch], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
    if (push.status !== 0) {
      console.warn(`  Warning: git push failed: ${push.stderr?.toString() ?? ''}`);
    }
  }

  // 4. Write .studio state file.
  const studioState = {
    sessionId,
    branch: currentBranch,
    databaseUrl: pg.url,
    containerId: pg.containerId,
  };
  writeFileSync(join(REPO_ROOT, '.studio'), JSON.stringify(studioState, null, 2));

  console.log(`  Session state written to .studio`);

  // 5. Exit immediately in bootstrap-only mode (tests and CI).
  if (EXIT_AFTER_BOOTSTRAP) {
    console.log('\n  Bootstrap complete. Exiting (STUDIO_EXIT_AFTER_BOOTSTRAP=1).\n');
    await cleanup();
    process.exit(0);
  }

  // 6. Normal mode: keep running (studio server will be started here in the future).
  console.log('\n  Studio bootstrapped. Press Ctrl+C to stop.\n');

  // Keep the process alive until interrupted.
  await new Promise<void>(() => {
    // Resolved only via SIGINT / SIGTERM handlers registered above.
  });
}
