/**
 * Integration tests for studio/apps/server/src/claude-session.ts
 *
 * Issue #166 test plan items covered:
 *   - Integration test: Claude subprocess spawns with correct flags
 *   - Integration test: SSE endpoint streams subprocess stdout in real time
 *   - Integration test: post-turn hook detects changed files from git diff
 *
 * These tests use a lightweight claude stub script (tests/fixtures/claude)
 * injected into PATH so no real Claude CLI is required. The stub echoes its
 * arguments to a log file so we can assert that --session-key and
 * --dangerously-skip-permissions were passed correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { join, delimiter } from 'path';
import { tmpdir } from 'os';
import { route } from '../../src/router';
import type { StudioConfig } from '../../src/config';

// ── Paths ─────────────────────────────────────────────────────────────────────

// Path to the stub claude executable in the studio repo's fixtures directory.
// The stub is already executable (755) and echoes args to CLAUDE_E2E_LOG_PATH.
const STUDIO_ROOT = new URL('../../../../', import.meta.url).pathname;
const FIXTURES_DIR = join(STUDIO_ROOT, 'tests', 'fixtures');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<StudioConfig> = {}): StudioConfig {
  return {
    port: 0,
    logDir: '/tmp/studio-test-logs',
    clusterContext: 'default',
    openBrowser: false,
    webServiceUrl: 'http://127.0.0.1:1',
    apiServiceUrl: 'http://127.0.0.1:1',
    assetsDir: undefined,
    ...overrides,
  };
}

/** Read all SSE events from a text/event-stream response body. */
async function collectSseEvents(
  response: Response,
): Promise<Array<{ event?: string; data: string }>> {
  const text = await response.text();
  const events: Array<{ event?: string; data: string }> = [];
  const blocks = text.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    let eventName: string | undefined;
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventName = line.slice('event: '.length);
      if (line.startsWith('data: ')) data = line.slice('data: '.length);
    }
    events.push({ event: eventName, data });
  }
  return events;
}

// ── SSE endpoint ──────────────────────────────────────────────────────────────

describe('GET /studio/chat/stream — SSE endpoint', () => {
  let tmpDir: string;
  let claudeLogPath: string;
  let savedPath: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    // Inject the claude stub into PATH so the server process finds it.
    tmpDir = join(
      tmpdir(),
      `studio-sse-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });

    claudeLogPath = join(tmpDir, 'claude.log');

    // Save and override PATH + CLAUDE_E2E_LOG_PATH for this test suite.
    savedPath = process.env.PATH ?? '';
    savedEnv = { ...process.env };
    process.env.PATH = `${FIXTURES_DIR}${delimiter}${savedPath}`;
    process.env.CLAUDE_E2E_LOG_PATH = claudeLogPath;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    Object.assign(process.env, savedEnv);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it('returns 400 when the message query parameter is missing', async () => {
    const config = makeConfig({ logDir: tmpDir });
    const req = new Request('http://localhost:7000/studio/chat/stream');
    const res = await route(req, config);
    expect(res.status).toBe(400);
  });

  it('returns 400 when the message query parameter is blank', async () => {
    const config = makeConfig({ logDir: tmpDir });
    const req = new Request('http://localhost:7000/studio/chat/stream?message=');
    const res = await route(req, config);
    expect(res.status).toBe(400);
  });

  it('returns Content-Type: text/event-stream for a valid message', async () => {
    const config = makeConfig({ logDir: tmpDir });
    const req = new Request(
      'http://localhost:7000/studio/chat/stream?message=hello+world',
    );
    const res = await route(req, config);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  });

  it('streams Claude stdout as SSE data events and ends with a done event', async () => {
    const config = makeConfig({ logDir: tmpDir });
    const req = new Request(
      'http://localhost:7000/studio/chat/stream?message=hello+from+test',
    );
    const res = await route(req, config);
    expect(res.status).toBe(200);

    const events = await collectSseEvents(res);

    // The stub emits "Mocked Claude response for studio e2e." so there should
    // be at least one data event containing content.
    const dataEvents = events.filter((e) => !e.event);
    expect(dataEvents.length).toBeGreaterThan(0);
    const combined = dataEvents.map((e) => e.data).join('');
    expect(combined).toContain('Mocked Claude response');

    // The final event must be a "done" event.
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();
  });

  it('writes a JSONL log entry after the turn completes', async () => {
    const config = makeConfig({ logDir: tmpDir });
    const req = new Request(
      'http://localhost:7000/studio/chat/stream?message=log+test+message',
    );
    const res = await route(req, config);
    // Drain the stream to ensure the log is written.
    await res.text();

    const date = new Date().toISOString().slice(0, 10);
    const logFile = join(tmpDir, `${date}.jsonl`);
    expect(existsSync(logFile)).toBe(true);

    const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const entry = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('message');
    expect(entry).toHaveProperty('response');
    expect(entry).toHaveProperty('filesChanged');
    expect(entry).toHaveProperty('servicesRestarted');
    expect(entry).toHaveProperty('restartDurationMs');
    expect(entry.message).toBe('log test message');
  });
});

// ── Claude subprocess flags ───────────────────────────────────────────────────

describe('Claude subprocess — correct flags', () => {
  let tmpDir: string;
  let claudeLogPath: string;
  let savedPath: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    tmpDir = join(
      tmpdir(),
      `studio-flags-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    claudeLogPath = join(tmpDir, 'claude-flags.log');

    savedPath = process.env.PATH ?? '';
    savedEnv = { ...process.env };
    process.env.PATH = `${FIXTURES_DIR}${delimiter}${savedPath}`;
    process.env.CLAUDE_E2E_LOG_PATH = claudeLogPath;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    Object.assign(process.env, savedEnv);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it('invokes the claude stub with --dangerously-skip-permissions and --session-key', async () => {
    const { streamTurn, SESSION_KEY } = await import('../../src/claude-session');
    const stream = streamTurn('test flag check', SESSION_KEY, tmpDir);
    const res = new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    // Drain to ensure the process exits and the log is written.
    await res.text();

    expect(existsSync(claudeLogPath)).toBe(true);
    const log = readFileSync(claudeLogPath, 'utf8');

    // The stub logs: ARGS: <all args>
    // We verify the required flags appear in the recorded args.
    expect(log).toContain('--dangerously-skip-permissions');
    expect(log).toContain('--session-key');
    expect(log).toContain(SESSION_KEY);
    // The -p flag must also be present with the message.
    expect(log).toContain('-p');
    expect(log).toContain('test flag check');
  });
});

// ── Post-turn hook — git diff ─────────────────────────────────────────────────

describe('post-turn hook — git diff changed files', () => {
  let tmpDir: string;
  let gitRepoDir: string;

  beforeAll(async () => {
    tmpDir = join(
      tmpdir(),
      `studio-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });

    // Initialise a minimal git repo for testing getChangedFiles.
    gitRepoDir = join(tmpDir, 'repo');
    mkdirSync(gitRepoDir, { recursive: true });

    const gitInit = spawnSync('git', ['init', gitRepoDir]);
    expect(gitInit.status).toBe(0);

    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepoDir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitRepoDir });

    // Create an initial commit so HEAD exists.
    writeFileSync(join(gitRepoDir, 'README.md'), '# Test\n');
    spawnSync('git', ['add', 'README.md'], { cwd: gitRepoDir });
    spawnSync('git', ['commit', '--no-gpg-sign', '-m', 'init'], { cwd: gitRepoDir });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it('detects files added after the base ref', async () => {
    const { getChangedFiles } = await import('../../src/claude-session');

    // Capture HEAD before adding a file.
    const headProc = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepoDir, stdio: 'pipe' });
    const baseRef = new TextDecoder().decode(headProc.stdout).trim();

    // Add a new file (untracked = appears in git diff HEAD).
    const newFile = join(gitRepoDir, 'apps', 'server', 'src', 'new-module.ts');
    mkdirSync(join(gitRepoDir, 'apps', 'server', 'src'), { recursive: true });
    writeFileSync(newFile, 'export const x = 1;\n');

    // Override CALYPSO_REPO_ROOT so getChangedFiles uses the test repo.
    const savedRoot = process.env.CALYPSO_REPO_ROOT;
    process.env.CALYPSO_REPO_ROOT = gitRepoDir;

    try {
      // git diff --name-only HEAD shows untracked changes relative to HEAD.
      // Since file is untracked (not staged), diff won't show it. Add it.
      spawnSync('git', ['add', '-A'], { cwd: gitRepoDir });
      const files = await getChangedFiles(baseRef);
      expect(files).toContain('apps/server/src/new-module.ts');
    } finally {
      process.env.CALYPSO_REPO_ROOT = savedRoot;
    }
  });
});
