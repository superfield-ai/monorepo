/**
 * Test git remote helper (stub — implemented in #92).
 *
 * Design decision: the e2e harness needs a real-ish git remote so that
 * `WorktreeManager.create` can clone into a tmp worktree the same way it does
 * in production. To avoid a network dependency we stand up a bare repository
 * on disk under `opts.tmpRoot` and expose it via a `file://` URL.
 *
 * Open question (for #92's implementer): the current `WorktreeManager` shells
 * out to `git clone`, which should accept `file://` fine — but if
 * `isomorphic-git` ends up being used anywhere in the clone path it may
 * reject `file://`. In that case, fall back to a localhost HTTP wrapper
 * around `isomorphic-git`'s smart HTTP server (`http-backend`) bound to
 * 127.0.0.1:0 and return that URL instead. Either way the interface below
 * stays the same.
 */

export interface TestGitRemote {
  remoteUrl: string;
  dispose(): Promise<void>;
}

export interface SeedCommit {
  branch: string;
  files: Record<string, string>;
}

export async function createTestGitRemote(_opts: {
  tmpRoot: string;
}): Promise<TestGitRemote> {
  throw new Error("not implemented — see #92");
}

export async function seedCommitsOnRemote(
  _remoteUrl: string,
  _commits: SeedCommit[],
): Promise<void> {
  throw new Error("not implemented — see #92");
}
