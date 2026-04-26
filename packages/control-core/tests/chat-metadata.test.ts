/**
 * Unit tests for packages/core/chat-metadata.ts
 *
 * Tests metadata initialization, turn appending, git notes I/O,
 * and push/fetch helpers. Git subprocess calls are replaced with
 * vi.mock() doubles — no real filesystem or subprocess involvement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the spawn module ────────────────────────────────────────────────────

vi.mock('../spawn', () => ({
  spawn: vi.fn(),
}));

import { spawn } from '../spawn';
import {
  NOTES_REF,
  SCHEMA_VERSION,
  initMetadata,
  appendTurn,
  writeMetadata,
  readMetadata,
  pushNotes,
  fetchNotes,
} from '../chat-metadata';
import type { ChatMetadata } from '../chat-metadata';

const mockSpawn = vi.mocked(spawn);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── initMetadata ─────────────────────────────────────────────────────────────

describe('initMetadata', () => {
  it('creates metadata with the correct session fields', () => {
    const meta = initMetadata('ab12', 'abc1234def5678', '2026-03-25T10:00:00.000Z');
    expect(meta.version).toBe(SCHEMA_VERSION);
    expect(meta.session.sessionId).toBe('ab12');
    expect(meta.session.baseCommit).toBe('abc1234def5678');
    expect(meta.session.startTime).toBe('2026-03-25T10:00:00.000Z');
    expect(meta.turns).toEqual([]);
  });

  it('defaults startTime to current time when not provided', () => {
    const before = new Date().toISOString();
    const meta = initMetadata('ab12', 'abc1234');
    const after = new Date().toISOString();
    expect(meta.session.startTime >= before).toBe(true);
    expect(meta.session.startTime <= after).toBe(true);
  });
});

// ── appendTurn ───────────────────────────────────────────────────────────────

describe('appendTurn', () => {
  const baseMeta: ChatMetadata = {
    version: 1,
    session: {
      sessionId: 'ab12',
      startTime: '2026-03-25T10:00:00.000Z',
      baseCommit: 'abc1234',
    },
    turns: [],
  };

  it('appends a design turn with checkpoint commit', () => {
    const updated = appendTurn(baseMeta, {
      mode: 'design',
      userMessage: 'Change the button color',
      assistantMessage: 'I updated the button color to blue.',
      timestamp: '2026-03-25T10:01:00.000Z',
      checkpointCommit: 'def5678',
    });

    expect(updated.turns).toHaveLength(1);
    expect(updated.turns[0]).toEqual({
      index: 0,
      mode: 'design',
      userMessage: 'Change the button color',
      assistantMessage: 'I updated the button color to blue.',
      timestamp: '2026-03-25T10:01:00.000Z',
      checkpointCommit: 'def5678',
    });
  });

  it('appends a question turn with null checkpoint', () => {
    const updated = appendTurn(baseMeta, {
      mode: 'question',
      userMessage: 'How does auth work?',
      assistantMessage: 'The auth flow uses JWT tokens.',
      timestamp: '2026-03-25T10:05:00.000Z',
      checkpointCommit: null,
    });

    expect(updated.turns).toHaveLength(1);
    expect(updated.turns[0].mode).toBe('question');
    expect(updated.turns[0].checkpointCommit).toBeNull();
  });

  it('auto-increments the turn index', () => {
    let meta = baseMeta;
    meta = appendTurn(meta, {
      mode: 'design',
      userMessage: 'First turn',
      assistantMessage: 'Done.',
      timestamp: '2026-03-25T10:01:00.000Z',
      checkpointCommit: 'aaa1111',
    });
    meta = appendTurn(meta, {
      mode: 'question',
      userMessage: 'Second turn',
      assistantMessage: 'Answer.',
      timestamp: '2026-03-25T10:02:00.000Z',
      checkpointCommit: null,
    });

    expect(meta.turns).toHaveLength(2);
    expect(meta.turns[0].index).toBe(0);
    expect(meta.turns[1].index).toBe(1);
  });

  it('does not mutate the original metadata', () => {
    const updated = appendTurn(baseMeta, {
      mode: 'design',
      userMessage: 'test',
      assistantMessage: 'test',
      checkpointCommit: null,
    });

    expect(baseMeta.turns).toHaveLength(0);
    expect(updated.turns).toHaveLength(1);
  });

  it('defaults timestamp to current time when not provided', () => {
    const before = new Date().toISOString();
    const updated = appendTurn(baseMeta, {
      mode: 'design',
      userMessage: 'test',
      assistantMessage: 'test',
      checkpointCommit: null,
    });
    const after = new Date().toISOString();

    expect(updated.turns[0].timestamp >= before).toBe(true);
    expect(updated.turns[0].timestamp <= after).toBe(true);
  });
});

// ── writeMetadata ────────────────────────────────────────────────────────────

describe('writeMetadata', () => {
  const meta: ChatMetadata = {
    version: 1,
    session: {
      sessionId: 'ab12',
      startTime: '2026-03-25T10:00:00.000Z',
      baseCommit: 'abc1234',
    },
    turns: [],
  };

  it('writes metadata as a git note on HEAD by default', () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    writeMetadata('/tmp/worktree', meta);

    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      ['notes', '--ref', NOTES_REF, 'add', '--force', '-m', JSON.stringify(meta, null, 2), 'HEAD'],
      { cwd: '/tmp/worktree' },
    );
  });

  it('writes metadata on a specific commit ref', () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    writeMetadata('/tmp/worktree', meta, 'abc1234');

    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      ['notes', '--ref', NOTES_REF, 'add', '--force', '-m', JSON.stringify(meta, null, 2), 'abc1234'],
      { cwd: '/tmp/worktree' },
    );
  });

  it('throws when git notes add fails', () => {
    mockSpawn.mockReturnValue({ status: 1, stdout: '', stderr: 'error: cannot add note' });

    expect(() => writeMetadata('/tmp/worktree', meta)).toThrow('git notes add failed');
  });
});

// ── readMetadata ─────────────────────────────────────────────────────────────

describe('readMetadata', () => {
  it('reads and parses metadata from a git note', () => {
    const meta: ChatMetadata = {
      version: 1,
      session: {
        sessionId: 'ab12',
        startTime: '2026-03-25T10:00:00.000Z',
        baseCommit: 'abc1234',
      },
      turns: [
        {
          index: 0,
          mode: 'design',
          userMessage: 'test',
          assistantMessage: 'done',
          timestamp: '2026-03-25T10:01:00.000Z',
          checkpointCommit: 'def5678',
        },
      ],
    };

    mockSpawn.mockReturnValue({
      status: 0,
      stdout: JSON.stringify(meta, null, 2),
      stderr: '',
    });

    const result = readMetadata('/tmp/worktree');
    expect(result).toEqual(meta);
    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      ['notes', '--ref', NOTES_REF, 'show', 'HEAD'],
      { cwd: '/tmp/worktree' },
    );
  });

  it('returns null when no note exists', () => {
    mockSpawn.mockReturnValue({ status: 1, stdout: '', stderr: 'error: no note found' });

    expect(readMetadata('/tmp/worktree')).toBeNull();
  });

  it('returns null when note contains invalid JSON', () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: 'not valid json', stderr: '' });

    expect(readMetadata('/tmp/worktree')).toBeNull();
  });

  it('reads from a specific commit ref', () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '{}', stderr: '' });

    readMetadata('/tmp/worktree', 'abc1234');

    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      ['notes', '--ref', NOTES_REF, 'show', 'abc1234'],
      { cwd: '/tmp/worktree' },
    );
  });
});

// ── pushNotes ────────────────────────────────────────────────────────────────

describe('pushNotes', () => {
  it('pushes the notes ref to origin', () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    pushNotes('/tmp/worktree');

    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', `refs/notes/${NOTES_REF}`],
      { cwd: '/tmp/worktree' },
    );
  });

  it('supports custom remote', () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    pushNotes('/tmp/worktree', 'upstream');

    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      ['push', 'upstream', `refs/notes/${NOTES_REF}`],
      { cwd: '/tmp/worktree' },
    );
  });

  it('throws when push fails', () => {
    mockSpawn.mockReturnValue({ status: 1, stdout: '', stderr: 'fatal: remote error' });

    expect(() => pushNotes('/tmp/worktree')).toThrow('git push notes failed');
  });
});

// ── fetchNotes ───────────────────────────────────────────────────────────────

describe('fetchNotes', () => {
  it('fetches the notes ref from origin', () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    fetchNotes('/tmp/worktree');

    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin', `refs/notes/${NOTES_REF}:refs/notes/${NOTES_REF}`],
      { cwd: '/tmp/worktree' },
    );
  });

  it('supports custom remote', () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    fetchNotes('/tmp/worktree', 'upstream');

    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      ['fetch', 'upstream', `refs/notes/${NOTES_REF}:refs/notes/${NOTES_REF}`],
      { cwd: '/tmp/worktree' },
    );
  });

  it('throws when fetch fails', () => {
    mockSpawn.mockReturnValue({ status: 1, stdout: '', stderr: 'fatal: fetch error' });

    expect(() => fetchNotes('/tmp/worktree')).toThrow('git fetch notes failed');
  });
});

// ── NOTES_REF constant ───────────────────────────────────────────────────────

describe('constants', () => {
  it('NOTES_REF is studio-chat', () => {
    expect(NOTES_REF).toBe('studio-chat');
  });

  it('SCHEMA_VERSION is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

// ── Sanitization by design ───────────────────────────────────────────────────

describe('metadata sanitization', () => {
  it('stored metadata contains only user messages and assistant responses', () => {
    const meta = initMetadata('ab12', 'abc1234', '2026-03-25T10:00:00.000Z');
    const updated = appendTurn(meta, {
      mode: 'design',
      userMessage: 'Change the color',
      assistantMessage: 'Done, I changed it.',
      timestamp: '2026-03-25T10:01:00.000Z',
      checkpointCommit: 'def5678',
    });

    // The metadata structure only has the fields we defined —
    // no internal reasoning, tool calls, or credentials.
    const json = JSON.stringify(updated);
    const parsed = JSON.parse(json);

    // Verify the shape matches exactly — no extra fields.
    expect(Object.keys(parsed)).toEqual(['version', 'session', 'turns']);
    expect(Object.keys(parsed.session)).toEqual(['sessionId', 'startTime', 'baseCommit']);
    expect(Object.keys(parsed.turns[0])).toEqual([
      'index', 'mode', 'userMessage', 'assistantMessage', 'timestamp', 'checkpointCommit',
    ]);
  });

  it('does not store files in the working tree (metadata is git notes only)', () => {
    // This is a design assertion — the writeMetadata function uses git notes,
    // not filesystem writes. Verified by the mock calls above.
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    const meta = initMetadata('ab12', 'abc1234');
    writeMetadata('/tmp/worktree', meta);

    // Only git notes commands were invoked, not any file writes.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe('git');
    expect(mockSpawn.mock.calls[0][1][0]).toBe('notes');
  });
});
