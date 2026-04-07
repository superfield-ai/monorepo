import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitClient } from '../../client.ts';

// We mock isomorphic-git at its API boundary. Testing the git wire protocol
// format is isomorphic-git's responsibility; our tests verify that GitClient
// calls the right functions with the right arguments and correctly maps results.
vi.mock('isomorphic-git', () => ({
  default: {
    listServerRefs: vi.fn(),
    clone: vi.fn(),
    resolveRef: vi.fn(),
  },
}));

const HEAD_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

import git from 'isomorphic-git';

const mockGit = vi.mocked(git);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitClient.getRemoteHeadSha', () => {
  it('returns the SHA for the requested branch', async () => {
    mockGit.listServerRefs.mockResolvedValue([
      { ref: 'refs/heads/main', oid: HEAD_SHA },
    ]);

    const client = new GitClient({ repoRoot: '/tmp/test-repos' });
    const sha = await client.getRemoteHeadSha('test-org', 'test-repo', 'main', 'ghp_test');
    expect(sha).toBe(HEAD_SHA);
  });

  it('calls listServerRefs with the correct url and auth', async () => {
    mockGit.listServerRefs.mockResolvedValue([
      { ref: 'refs/heads/main', oid: HEAD_SHA },
    ]);

    const client = new GitClient({ repoRoot: '/tmp/test-repos' });
    await client.getRemoteHeadSha('test-org', 'test-repo', 'main', 'ghp_test');

    expect(mockGit.listServerRefs).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://github.com/test-org/test-repo.git',
        prefix: 'refs/heads/main',
      }),
    );
  });

  it('throws when the branch is not found', async () => {
    mockGit.listServerRefs.mockResolvedValue([]);

    const client = new GitClient({ repoRoot: '/tmp/test-repos' });
    await expect(
      client.getRemoteHeadSha('test-org', 'test-repo', 'missing-branch', 'ghp_test'),
    ).rejects.toThrow('Branch missing-branch not found');
  });
});

describe('GitClient.resolveRef', () => {
  it('delegates to isomorphic-git resolveRef', async () => {
    mockGit.resolveRef.mockResolvedValue(HEAD_SHA);

    const client = new GitClient({ repoRoot: '/tmp/test-repos' });
    const sha = await client.resolveRef('test-org', 'test-repo', 'HEAD');

    expect(sha).toBe(HEAD_SHA);
    expect(mockGit.resolveRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'HEAD' }),
    );
  });
});
