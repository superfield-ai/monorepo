/**
 * @file helpers.ts
 *
 * Shared types, parsing utilities, and prompt-building helpers for the
 * studio server API handlers.
 *
 * ## Exports
 *
 *   - StudioInfo / StudioMessage / StudioMode — shared data types
 *   - parseStudioInfo() — parse the .studio session file
 *   - parseSessionCommits() / parseTimelineCommits() — parse git log output
 *   - validateStudioMessage() / validateRollbackHash() — input validation
 *   - buildStudioPrompt() — assemble the full Claude prompt for a turn
 *   - getStudioSystemPrompt() — the base design-mode system context string
 */

import { buildQuestionModePrompt as _buildQuestionModePrompt } from './question-mode';

export interface StudioInfo {
  sessionId: string;
  branch: string;
}

export interface StudioMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Studio agent mode — 'design' for full read/write, 'question' for read-only Q&A. */
export type StudioMode = 'design' | 'question';

/**
 * Parse the JSON content of the `.studio` session file.
 *
 * @returns Parsed StudioInfo, or null if the file is missing or malformed.
 */
export function parseStudioInfo(raw: string): StudioInfo | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StudioInfo>;
    if (typeof parsed.sessionId !== 'string' || typeof parsed.branch !== 'string') {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      branch: parsed.branch,
    };
  } catch {
    return null;
  }
}

/**
 * Parse `git log --oneline` output into commit objects.
 *
 * Each line is expected to be: `<hash> <message>`
 * Returns an empty array for empty input.
 */
export function parseSessionCommits(output: string): { hash: string; message: string }[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const spaceIdx = line.indexOf(' ');
      return { hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) };
    });
}

/**
 * Parse structured git log output with timestamps.
 *
 * Expected format per line: `<hash>|<iso-date>|<subject>`
 * The subject may contain pipe characters, so we split on the first two pipes only.
 */
export function parseTimelineCommits(
  output: string,
): { hash: string; message: string; timestamp: string }[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const firstPipe = line.indexOf('|');
      const secondPipe = line.indexOf('|', firstPipe + 1);
      if (firstPipe === -1 || secondPipe === -1) {
        return null;
      }
      return {
        hash: line.slice(0, firstPipe),
        timestamp: line.slice(firstPipe + 1, secondPipe),
        message: line.slice(secondPipe + 1),
      };
    })
    .filter((entry): entry is { hash: string; message: string; timestamp: string } => entry !== null);
}

/**
 * Validate and trim an incoming studio message string.
 *
 * @returns Trimmed message, or null if empty or not a string.
 */
export function validateStudioMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed ? trimmed : null;
}

/**
 * Validate and trim a rollback target hash string.
 *
 * @returns Trimmed hash, or null if empty or not a string.
 */
export function validateRollbackHash(hash: unknown): string | null {
  if (typeof hash !== 'string') return null;
  const trimmed = hash.trim();
  return trimmed ? trimmed : null;
}

/**
 * Build the Design mode system context string for a Claude CLI invocation.
 *
 * Instructs Claude to make changes and commit them after every turn on the
 * given session branch. The branch is embedded in the prompt so Claude knows
 * where to write the changes narrative.
 *
 * @param branch  The current studio session branch name.
 */
export function getStudioSystemPrompt(branch: string): string {
  return `You are a studio mode agent for Calypso. You are helping a business partner explore UI and workflow changes to the Calypso application in a live session.

## Your Role

You make changes to the codebase based on the partner's plain-language feedback. You can touch any file in the repository — frontend, backend, schema, packages. This is an exploratory session on a throwaway branch (${branch}). Things can break. That is fine.

## After Every Turn

After making changes, you MUST:
1. Update \`docs/studio-sessions/${branch}/changes.md\` with a new section describing what you changed and why. If the file doesn't exist, create it with a header. Always append — never overwrite prior turns.
2. Run: git add -A && git commit --no-verify -m "<short description of this turn>"

## Changes Narrative Format

Append to \`docs/studio-sessions/${branch}/changes.md\` after each turn:

### Turn N — <short title>
<What changed, why the partner wanted it, what it looks like now>
<If backend/schema changes are needed that you didn't implement: **Requires backend:** description>

## Important

- The Postgres DB is disposable. If you change the schema, note that a container reset will break the session unless seeds are updated.
- Keep your reply to the partner short and conversational. Describe what you did in plain language.
- Do not ask clarifying questions unless absolutely necessary. Make a reasonable interpretation and proceed.`;
}

/**
 * Assemble the full prompt string for a Claude CLI turn.
 *
 * In 'question' mode, delegates to buildQuestionModePrompt().
 * In 'design' mode, uses getStudioSystemPrompt() with the conversation
 * history formatted as Partner/Agent alternating lines.
 *
 * @param branch          Session branch name (embedded in system prompt).
 * @param messages        Full conversation history for this session.
 * @param changesContent  Contents of changes.md if it exists (appended as context).
 * @param mode            Agent mode: 'design' (default) or 'question'.
 */
export function buildStudioPrompt({
  branch,
  messages,
  changesContent,
  mode = 'design',
}: {
  branch: string;
  messages: StudioMessage[];
  changesContent?: string;
  mode?: StudioMode;
}): string {
  // In question mode, delegate to the question mode prompt builder
  if (mode === 'question') {
    const lastMessage = messages[messages.length - 1];
    const question = lastMessage?.role === 'user' ? lastMessage.content : '';
    const history = messages.length > 1 ? messages.slice(0, -1) : [];
    return _buildQuestionModePrompt({
      branch,
      question,
      conversationHistory: history,
    });
  }

  const conversationText = messages
    .map((message) => `${message.role === 'user' ? 'Partner' : 'Agent'}: ${message.content}`)
    .join('\n\n');

  const changesContext = changesContent
    ? `\n\nCurrent changes.md:\n\`\`\`\n${changesContent}\n\`\`\``
    : '';

  return `${getStudioSystemPrompt(branch)}${changesContext}\n\n## Conversation\n\n${conversationText}\n\nAgent:`;
}
