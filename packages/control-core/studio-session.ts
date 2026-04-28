/**
 * @file studio-session.ts
 *
 * Session ID generation, branch naming, and session resolution for
 * studio sessions.
 *
 * ## Branch naming convention
 *
 *   studio/session-<mainHash>-<sessionId>
 *
 *   - mainHash: the full 40-char SHA of the main branch HEAD at session start.
 *   - sessionId: 4-character alphanumeric string (36^4 ≈ 1.7 million combinations).
 *
 * ## Session ID format
 *
 *   4 characters drawn from [a-z0-9] using cryptographic random bytes.
 *   Short enough to be human-readable in branch names and log messages.
 *
 * @see worktree-manager.ts — creates the worktree using the branch name built here.
 */

const SESSION_ID_LENGTH = 4;
const SESSION_ID_PATTERN = /^[a-z0-9]{4}$/;
const SESSION_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Construct the canonical studio session branch name.
 *
 * @param mainHash   Full SHA of the main branch HEAD at session start.
 * @param sessionId  4-character alphanumeric session identifier.
 * @returns          Branch name string: `studio/session-<mainHash>-<sessionId>`
 */
export function buildStudioBranchName(
  mainHash: string,
  sessionId: string,
): string {
  return `studio/session-${mainHash}-${sessionId}`;
}

/**
 * Parse a branch name and extract the session ID if it matches the
 * studio session pattern for the given main HEAD hash.
 *
 * @param branch    The branch name to parse.
 * @param mainHash  The main HEAD hash to match against.
 * @returns         Object with sessionId, or null if the branch doesn't match.
 */
export function parseStudioBranchName(
  branch: string,
  mainHash: string,
): { sessionId: string } | null {
  const pattern = new RegExp(`^studio/session-${mainHash}-[a-z0-9]{4}$`);
  if (!pattern.test(branch)) return null;
  return { sessionId: branch.slice(`studio/session-${mainHash}-`.length) };
}

/**
 * Check whether a string is a valid 4-character alphanumeric session ID.
 */
export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Generate a cryptographically random 4-character session ID.
 *
 * Uses crypto.getRandomValues for the random bytes. The optional
 * `randomBytes` parameter allows tests to inject deterministic values.
 *
 * @param randomBytes  Optional pre-generated random bytes (for testing).
 */
export function generateSessionId(randomBytes?: Uint8Array): string {
  const bytes =
    randomBytes ?? crypto.getRandomValues(new Uint8Array(SESSION_ID_LENGTH));
  let sessionId = "";
  for (let i = 0; i < SESSION_ID_LENGTH; i += 1) {
    const b = bytes[i] ?? 0;
    sessionId += SESSION_ID_ALPHABET[b % SESSION_ID_ALPHABET.length] ?? "";
  }
  return sessionId;
}

type ResolveStudioSessionOptions = {
  currentBranch: string;
  mainHash: string;
};

type ResolveStudioSessionResult = {
  branch: string;
  sessionId: string;
};

/**
 * Validate that the current branch is a studio session branch and extract
 * the session ID.
 *
 * Called at server startup to confirm the repo is in a studio session
 * and to recover the session ID from the branch name.
 *
 * @throws If the current branch does not match the studio session pattern.
 */
export function resolveStudioSession({
  currentBranch,
  mainHash,
}: ResolveStudioSessionOptions): ResolveStudioSessionResult {
  const parsed = parseStudioBranchName(currentBranch, mainHash);
  if (!parsed) {
    throw new Error(
      `Studio requires a branch named studio/session-${mainHash}-<session-id>.`,
    );
  }

  return {
    branch: currentBranch,
    sessionId: parsed.sessionId,
  };
}
