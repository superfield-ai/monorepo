/**
 * @file agent.ts
 *
 * Claude CLI agent runner for the Studio Server.
 *
 * ## Responsibilities
 *
 *   - Resolve the repo root from CALYPSO_REPO_ROOT (or process.cwd()).
 *   - Load the optional changes.md context document for the session branch.
 *   - Build the full studio prompt from conversation history and mode.
 *   - Spawn Claude CLI headlessly via Bun.spawn and collect its stdout.
 *
 * ## Integration points
 *
 *   - api.ts: handleStudioRequest() calls runAgent() for POST /studio/chat.
 *   - helpers.ts: buildStudioPrompt() / buildQuestionModePrompt() construct
 *     the prompt string passed to Claude CLI.
 *   - permissions.ts: buildAllowedToolsFlag() determines which tools Claude
 *     may use in the given mode.
 */

import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { buildStudioPrompt, type StudioMessage, type StudioMode } from './helpers';
import { readProcStdout } from '../lib/response';
import { buildAllowedToolsFlag } from './permissions';

export const REPO_ROOT = process.env.CALYPSO_REPO_ROOT ?? process.cwd();

/**
 * Invoke Claude CLI for one turn and return its full stdout response.
 *
 * Loads the session's changes.md document (if present) to give Claude
 * context about what has already been changed in this session. Spawns
 * `claude -p <prompt> --dangerously-skip-permissions --allowedTools <tools>`.
 *
 * @param messages  Full conversation history for the session.
 * @param branch    The current studio session branch name.
 * @param mode      Agent mode — 'design' (default) or 'question'.
 * @returns         Claude's trimmed response string.
 */
export async function runAgent(
  messages: StudioMessage[],
  branch: string,
  mode: StudioMode = 'design',
): Promise<string> {
  const changesPath = join(REPO_ROOT, `docs/studio-sessions/${branch}/changes.md`);
  const changesContent = existsSync(changesPath) ? readFileSync(changesPath, 'utf8') : undefined;
  const fullPrompt = buildStudioPrompt({
    branch,
    messages,
    changesContent,
    mode,
  });

  const allowedToolsFlag = buildAllowedToolsFlag(mode);
  const proc = Bun.spawn([
    'claude', '-p', fullPrompt,
    '--dangerously-skip-permissions',
    '--allowedTools', allowedToolsFlag,
  ], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await readProcStdout(proc.stdout);
  await proc.exited;

  return output.trim();
}
