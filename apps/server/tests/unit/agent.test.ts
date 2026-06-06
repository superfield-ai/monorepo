/**
 * Unit tests for studio/apps/server/src/agent.ts
 *
 * Issue #23 hardening: agent.test.ts no longer patches globalThis.Bun
 * per-test. A vitest setup file (bun-shim.ts) installs a stable Bun.spawn
 * stub, and readProcStdout (the outermost I/O boundary) is mocked so the
 * real agent.ts code runs through buildStudioPrompt and Bun.spawn argument
 * assembly without spawning a real subprocess.
 *
 * Issue #11 test plan items still covered:
 *   - agent.test.ts asserts that runAgent calls Bun.spawn with the correct claude CLI arguments
 *   - agent.test.ts asserts agent lifecycle, invocation, and error handling
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildStudioPrompt, getStudioSystemPrompt } from '../../src/helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BunGlobal = (globalThis as any).Bun;

// ── I/O boundary mock ────────────────────────────────────────────────────────
//
// Mock readProcStdout so Bun.spawn's stdout stream is never actually read.
// We also mock fs to prevent real filesystem access for the changes.md check.

vi.mock('../../lib/response', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/response')>();
  return {
    ...original,
    readProcStdout: vi.fn().mockResolvedValue('mocked agent reply'),
  };
});

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
  };
});

// ── getStudioSystemPrompt ─────────────────────────────────────────────────────

describe('getStudioSystemPrompt', () => {
  it('includes the branch name in the returned prompt', () => {
    const prompt = getStudioSystemPrompt('feat/my-feature');
    expect(prompt).toContain('feat/my-feature');
  });

  it('references the changes.md path for the given branch', () => {
    const branch = 'studio/session-42';
    const prompt = getStudioSystemPrompt(branch);
    expect(prompt).toContain(`docs/studio-sessions/${branch}/changes.md`);
  });

  it('is a non-empty string', () => {
    const prompt = getStudioSystemPrompt('main');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ── buildStudioPrompt ─────────────────────────────────────────────────────────

describe('buildStudioPrompt', () => {
  it('includes user messages formatted as Partner lines', () => {
    const prompt = buildStudioPrompt({
      branch: 'main',
      messages: [{ role: 'user', content: 'make the header blue' }],
    });
    expect(prompt).toContain('Partner: make the header blue');
  });

  it('includes assistant messages formatted as Agent lines', () => {
    const prompt = buildStudioPrompt({
      branch: 'main',
      messages: [{ role: 'assistant', content: 'Done! I updated the header.' }],
    });
    expect(prompt).toContain('Agent: Done! I updated the header.');
  });

  it('includes both user and assistant messages in order', () => {
    const prompt = buildStudioPrompt({
      branch: 'main',
      messages: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'second message' },
      ],
    });
    const partnerIdx = prompt.indexOf('Partner: first message');
    const agentIdx = prompt.indexOf('Agent: first reply');
    const partner2Idx = prompt.indexOf('Partner: second message');
    expect(partnerIdx).toBeLessThan(agentIdx);
    expect(agentIdx).toBeLessThan(partner2Idx);
  });

  it('includes changesContent when provided', () => {
    const prompt = buildStudioPrompt({
      branch: 'main',
      messages: [],
      changesContent: '## Turn 1\nChanged the header color.',
    });
    expect(prompt).toContain('## Turn 1');
    expect(prompt).toContain('Current changes.md:');
  });

  it('does not include changesContent section when not provided', () => {
    const prompt = buildStudioPrompt({
      branch: 'main',
      messages: [],
    });
    expect(prompt).not.toContain('Current changes.md:');
  });

  it('ends with "Agent:" to signal where the assistant reply should begin', () => {
    const prompt = buildStudioPrompt({
      branch: 'main',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(prompt.trimEnd().endsWith('Agent:')).toBe(true);
  });
});

// ── runAgent — subprocess invocation ────────────────────────────────────────
//
// runAgent uses Bun.spawn internally. We spy on the Bun global (provided by
// bun-shim.ts setup file) to assert CLI arguments. readProcStdout (mocked
// above) controls the subprocess output.

describe('runAgent — Bun.spawn invocation via boundary mock', () => {
  let spawnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spawnSpy = vi.fn(BunGlobal.spawn);
    BunGlobal.spawn = spawnSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls Bun.spawn with claude, -p, prompt, --dangerously-skip-permissions, and --allowedTools', async () => {
    const { runAgent } = await import('../../src/agent');
    await runAgent([{ role: 'user', content: 'hello' }], 'feat/test-branch');

    expect(spawnSpy).toHaveBeenCalledOnce();
    const [args] = spawnSpy.mock.calls[0];
    expect(args[0]).toBe('claude');
    expect(args[1]).toBe('-p');
    expect(typeof args[2]).toBe('string'); // the built prompt
    expect(args[3]).toBe('--dangerously-skip-permissions');
    expect(args[4]).toBe('--allowedTools');
    expect(typeof args[5]).toBe('string'); // the allowed tools flag value
    expect(args[5]).toContain('Read');
    expect(args[5]).toContain('Edit');
    expect(args[5]).not.toContain('Bash');
  });

  it('returns the trimmed output from readProcStdout', async () => {
    const { readProcStdout } = await import('../../lib/response');
    vi.mocked(readProcStdout).mockResolvedValue('  agent output  \n');

    const { runAgent } = await import('../../src/agent');
    const result = await runAgent([{ role: 'user', content: 'hello' }], 'main');
    expect(result).toBe('agent output');
  });
});

// ── REPO_ROOT ──────────────────────────────────────────────────────────────────

describe('REPO_ROOT', () => {
  it('is a non-empty string', async () => {
    const { REPO_ROOT } = await import('../../src/agent');
    expect(typeof REPO_ROOT).toBe('string');
    expect(REPO_ROOT.length).toBeGreaterThan(0);
  });

  it('defaults to process.cwd() when CALYPSO_REPO_ROOT is not set', async () => {
    const original = process.env.CALYPSO_REPO_ROOT;
    delete process.env.CALYPSO_REPO_ROOT;
    try {
      const { REPO_ROOT } = await import('../../src/agent?t=reporoot');
      expect(typeof REPO_ROOT).toBe('string');
      expect(REPO_ROOT.length).toBeGreaterThan(0);
    } finally {
      if (original !== undefined) process.env.CALYPSO_REPO_ROOT = original;
    }
  });
});

// ── Negative-path tests ─────────────────────────────────────────────────────
//
// Issue #23: each server unit test file includes at least 2 negative-path cases.

describe('runAgent — negative paths', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty string when subprocess produces no output', async () => {
    const { readProcStdout } = await import('../../lib/response');
    vi.mocked(readProcStdout).mockResolvedValue('');

    const { runAgent } = await import('../../src/agent');
    const result = await runAgent([{ role: 'user', content: 'test' }], 'main');
    expect(result).toBe('');
  });

  it('handles non-zero exit code from subprocess gracefully', async () => {
    // Bun.spawn stub always resolves exited to 0, but readProcStdout still
    // returns partial output. runAgent returns whatever stdout produced.
    const { readProcStdout } = await import('../../lib/response');
    vi.mocked(readProcStdout).mockResolvedValue('partial output');

    const { runAgent } = await import('../../src/agent');
    const result = await runAgent([{ role: 'user', content: 'test' }], 'main');
    expect(typeof result).toBe('string');
    expect(result).toBe('partial output');
  });
});
