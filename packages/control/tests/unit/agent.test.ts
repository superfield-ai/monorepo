/**
 * Unit tests for packages/control/src/agent.ts
 *
 * Since Phase 3, runAgent() calls POST /studio/run on the superfield API
 * instead of spawning claude directly. Tests stub the _fetch parameter.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildStudioPrompt, getStudioSystemPrompt } from '../../src/helpers';

// Mock fs so the changes.md existsSync check never hits disk.
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSseBody(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(e));
      }
      controller.close();
    },
  });
}

function makeFetch(sseLines: string[], status = 200): typeof fetch {
  const body = makeSseBody(sseLines);
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    body,
  } as unknown as Response);
}

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
    const prompt = buildStudioPrompt({ branch: 'main', messages: [] });
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

// ── runAgent — fetch boundary mock ───────────────────────────────────────────

describe('runAgent — POST /studio/run via fetch stub', () => {
  it('calls POST /studio/run with the built prompt and allowed tools', async () => {
    const fetchSpy = makeFetch([
      'event: session\ndata: {"sessionId":"abc"}\n\n',
      'data: agent output\n\n',
      'event: done\ndata: {"filesChanged":[]}\n\n',
    ]);
    const { runAgent } = await import('../../src/agent');
    await runAgent([{ role: 'user', content: 'hello' }], 'feat/test', 'design', fetchSpy as unknown as typeof fetch);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/studio/run');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.allowedTools).toContain('Read');
    expect(body.allowedTools).toContain('Edit');
    expect(body.allowedTools).not.toContain('Bash');
  });

  it('returns trimmed text from data: lines in the SSE stream', async () => {
    const fetchSpy = makeFetch([
      'event: session\ndata: {"sessionId":"abc"}\n\n',
      'data: agent output  \n\n',
      'event: done\ndata: {"filesChanged":[]}\n\n',
    ]);
    const { runAgent } = await import('../../src/agent');
    const result = await runAgent([{ role: 'user', content: 'hello' }], 'main', 'design', fetchSpy as unknown as typeof fetch);
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

  it('defaults to process.cwd() when SUPERFIELD_REPO_ROOT is not set', async () => {
    const original = process.env.SUPERFIELD_REPO_ROOT;
    delete process.env.SUPERFIELD_REPO_ROOT;
    try {
      const { REPO_ROOT } = await import('../../src/agent?t=reporoot');
      expect(typeof REPO_ROOT).toBe('string');
      expect(REPO_ROOT.length).toBeGreaterThan(0);
    } finally {
      if (original !== undefined) process.env.SUPERFIELD_REPO_ROOT = original;
    }
  });
});

// ── Negative-path tests ─────────────────────────────────────────────────────

describe('runAgent — negative paths', () => {
  it('returns empty string when the SSE stream has no data lines', async () => {
    const fetchSpy = makeFetch([
      'event: session\ndata: {"sessionId":"abc"}\n\n',
      'event: done\ndata: {"filesChanged":[]}\n\n',
    ]);
    const { runAgent } = await import('../../src/agent');
    const result = await runAgent([{ role: 'user', content: 'test' }], 'main', 'design', fetchSpy as unknown as typeof fetch);
    expect(result).toBe('');
  });

  it('throws when the SSE stream emits an error event', async () => {
    const fetchSpy = makeFetch([
      'event: session\ndata: {"sessionId":"abc"}\n\n',
      'event: error\ndata: "claude exited with code 1"\n\n',
    ]);
    const { runAgent } = await import('../../src/agent');
    await expect(
      runAgent([{ role: 'user', content: 'test' }], 'main', 'design', fetchSpy as unknown as typeof fetch),
    ).rejects.toThrow('Agent error');
  });

  it('throws when fetch returns a non-ok status', async () => {
    const fetchSpy = makeFetch([], 503);
    const { runAgent } = await import('../../src/agent');
    await expect(
      runAgent([{ role: 'user', content: 'test' }], 'main', 'design', fetchSpy as unknown as typeof fetch),
    ).rejects.toThrow('POST /studio/run failed');
  });
});
