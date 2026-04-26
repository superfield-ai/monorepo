/**
 * @file chat-metadata.ts
 *
 * Structured JSON chat metadata storage via git notes.
 *
 * Canonical spec: docs/studio-chat-metadata.md
 *
 * ## Responsibilities
 *
 *   - Initialize session metadata (session ID, start time, base commit).
 *   - Append turn metadata after each turn completes.
 *   - Store the full metadata blob as a git note on the session branch HEAD.
 *   - Read metadata back from any commit on the session branch.
 *   - Push notes ref to remote for downstream agent retrieval.
 *
 * ## Storage
 *
 *   Metadata is stored as a JSON blob in `refs/notes/studio-chat`, attached
 *   to the HEAD commit of the session branch. The note is overwritten on
 *   every turn with the full accumulated metadata.
 *
 * ## Sanitization
 *
 *   Only plain-text user messages and assistant responses are stored.
 *   Internal reasoning, tool calls, credentials, and cluster runtime data
 *   are excluded by design — callers pass only sanitized content.
 *
 * @see docs/studio-chat-metadata.md
 */

import { spawn } from './spawn';

// ── Constants ────────────────────────────────────────────────────────────────

/** The git notes ref used for studio chat metadata. */
export const NOTES_REF = 'studio-chat';

/** Current schema version for forward compatibility. */
export const SCHEMA_VERSION = 1;

// ── Types ────────────────────────────────────────────────────────────────────

/** Session-level metadata. */
export interface ChatSessionMeta {
  /** The 4-character session identifier. */
  sessionId: string;
  /** ISO 8601 timestamp when the session began. */
  startTime: string;
  /** Full commit hash of the main branch fork point. */
  baseCommit: string;
}

/** A single chat turn. */
export interface ChatTurnMeta {
  /** Zero-based turn index. */
  index: number;
  /** Studio mode for this turn. */
  mode: 'design' | 'question';
  /** The user's message (sanitized — no credentials or internal data). */
  userMessage: string;
  /** Claude's response (sanitized — no tool calls or reasoning). */
  assistantMessage: string;
  /** ISO 8601 timestamp of the turn. */
  timestamp: string;
  /** Abbreviated checkpoint commit SHA, or null if no checkpoint was created. */
  checkpointCommit: string | null;
}

/** The complete metadata blob stored as a git note. */
export interface ChatMetadata {
  /** Schema version for forward compatibility. */
  version: number;
  /** Session-level metadata. */
  session: ChatSessionMeta;
  /** Ordered list of chat turns. */
  turns: ChatTurnMeta[];
}

// ── Initialization ───────────────────────────────────────────────────────────

/**
 * Create a new empty ChatMetadata blob for a session.
 *
 * @param sessionId  The 4-character session identifier.
 * @param baseCommit Full commit hash of the fork point.
 * @param startTime  Optional ISO 8601 timestamp (defaults to now).
 */
export function initMetadata(
  sessionId: string,
  baseCommit: string,
  startTime?: string,
): ChatMetadata {
  return {
    version: SCHEMA_VERSION,
    session: {
      sessionId,
      startTime: startTime ?? new Date().toISOString(),
      baseCommit,
    },
    turns: [],
  };
}

// ── Turn appending ───────────────────────────────────────────────────────────

export interface AppendTurnOptions {
  /** Studio mode for this turn. */
  mode: 'design' | 'question';
  /** The user's message (sanitized). */
  userMessage: string;
  /** Claude's response (sanitized). */
  assistantMessage: string;
  /** ISO 8601 timestamp of the turn (defaults to now). */
  timestamp?: string;
  /** Abbreviated checkpoint commit SHA, or null. */
  checkpointCommit: string | null;
}

/**
 * Append a turn to the metadata blob.
 *
 * Returns a new ChatMetadata object — the original is not mutated.
 */
export function appendTurn(
  metadata: ChatMetadata,
  opts: AppendTurnOptions,
): ChatMetadata {
  const turn: ChatTurnMeta = {
    index: metadata.turns.length,
    mode: opts.mode,
    userMessage: opts.userMessage,
    assistantMessage: opts.assistantMessage,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    checkpointCommit: opts.checkpointCommit,
  };

  return {
    ...metadata,
    turns: [...metadata.turns, turn],
  };
}

// ── Git notes I/O ────────────────────────────────────────────────────────────

/**
 * Write the metadata blob as a git note on the specified commit.
 *
 * Uses `git notes --ref=studio-chat add --force` to overwrite any
 * existing note on the commit. The JSON is passed via stdin to avoid
 * shell escaping issues with large payloads.
 *
 * @param worktreePath  Absolute path to the session worktree.
 * @param metadata      The metadata blob to store.
 * @param commitRef     The commit to attach the note to (default: HEAD).
 * @throws If git notes add fails.
 */
export function writeMetadata(
  worktreePath: string,
  metadata: ChatMetadata,
  commitRef: string = 'HEAD',
): void {
  const json = JSON.stringify(metadata, null, 2);
  const result = spawn(
    'git',
    ['notes', '--ref', NOTES_REF, 'add', '--force', '-m', json, commitRef],
    { cwd: worktreePath },
  );
  if (result.status !== 0) {
    throw new Error(`git notes add failed: ${result.stderr.trim()}`);
  }
}

/**
 * Read the metadata blob from a git note on the specified commit.
 *
 * @param worktreePath  Absolute path to the session worktree.
 * @param commitRef     The commit to read the note from (default: HEAD).
 * @returns Parsed ChatMetadata, or null if no note exists.
 */
export function readMetadata(
  worktreePath: string,
  commitRef: string = 'HEAD',
): ChatMetadata | null {
  const result = spawn(
    'git',
    ['notes', '--ref', NOTES_REF, 'show', commitRef],
    { cwd: worktreePath },
  );
  if (result.status !== 0) {
    // No note exists on this commit.
    return null;
  }

  try {
    return JSON.parse(result.stdout.trim()) as ChatMetadata;
  } catch {
    return null;
  }
}

// ── Push / fetch helpers ─────────────────────────────────────────────────────

/**
 * Push the studio-chat notes ref to the remote.
 *
 * @param worktreePath Absolute path to the session worktree.
 * @param remote       Remote name (default: "origin").
 * @throws If git push fails.
 */
export function pushNotes(
  worktreePath: string,
  remote: string = 'origin',
): void {
  const result = spawn(
    'git',
    ['push', remote, `refs/notes/${NOTES_REF}`],
    { cwd: worktreePath },
  );
  if (result.status !== 0) {
    throw new Error(`git push notes failed: ${result.stderr.trim()}`);
  }
}

/**
 * Fetch the studio-chat notes ref from the remote.
 *
 * @param worktreePath Absolute path to the session worktree.
 * @param remote       Remote name (default: "origin").
 * @throws If git fetch fails.
 */
export function fetchNotes(
  worktreePath: string,
  remote: string = 'origin',
): void {
  const result = spawn(
    'git',
    ['fetch', remote, `refs/notes/${NOTES_REF}:refs/notes/${NOTES_REF}`],
    { cwd: worktreePath },
  );
  if (result.status !== 0) {
    throw new Error(`git fetch notes failed: ${result.stderr.trim()}`);
  }
}
