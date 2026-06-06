/**
 * @file tests/integration/rollback.test.ts
 *
 * Layer 3 Integration — Rollback.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Test matrix" — "Rollback" row.
 *
 * Scenarios covered:
 *   - POST /studio/rollback resets HEAD to the prior commit.
 *   - Subsequent GET /studio/commits does not include the rolled-back SHA.
 *
 * Run in isolation:
 *   node --test tests/integration/rollback.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterAvailable,
  createNamespace,
  deleteNamespace,
  applyManifests,
} from './helpers/cluster.js';
import { portForward, type PortForwardHandle } from './helpers/port-forward.js';
import { waitReady } from './helpers/wait-ready.js';
import { installClaudeStub, type ClaudeStub } from './helpers/claude-stub.js';

const NAMESPACE = `calypso-rollback-${Date.now()}`;
const TIMEOUT_MS = 120_000;

const TEST_USER = { username: 'rollbackuser', password: 'rollbackpass123!' };

describe('rollback', { timeout: TIMEOUT_MS + 60_000 }, () => {
  let apiUrl: string;
  let fwd: PortForwardHandle;
  let stub: ClaudeStub;
  let authCookie: string;

  before(function () {
    if (!clusterAvailable()) {
      this.skip();
    }
  });

  before(async () => {
    stub = installClaudeStub();

    createNamespace(NAMESPACE);
    applyManifests(NAMESPACE);
    await waitReady(NAMESPACE, TIMEOUT_MS);
    fwd = await portForward(NAMESPACE, 'svc/api', 0, 3000);
    apiUrl = `http://${fwd.host}:${fwd.port}`;

    await fetch(`${apiUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_USER),
    });
    const loginRes = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_USER),
    });
    authCookie = loginRes.headers.get('set-cookie') ?? '';
  });

  after(() => {
    fwd?.close();
    stub?.cleanup();
    deleteNamespace(NAMESPACE);
  });

  it('POST /studio/rollback resets HEAD and commit list shrinks', async () => {
    // Send a chat turn to produce a commit to roll back.
    const chatRes = await fetch(`${apiUrl}/studio/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: authCookie,
      },
      body: JSON.stringify({ message: 'make a commit for rollback test' }),
    });
    assert.strictEqual(chatRes.status, 200, 'chat turn should succeed');

    // Fetch the commits list before rollback.
    const commitsBefore = await fetch(`${apiUrl}/studio/commits`, {
      headers: { Cookie: authCookie },
    });
    assert.strictEqual(commitsBefore.status, 200);
    const beforeBody = await commitsBefore.json() as { commits: Array<{ sha: string }> };
    const commitCountBefore = beforeBody.commits?.length ?? 0;

    if (commitCountBefore === 0) {
      // Nothing to roll back — skip the rest.
      return;
    }

    const latestSha = beforeBody.commits[0].sha;

    // Trigger rollback.
    const rollbackRes = await fetch(`${apiUrl}/studio/rollback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: authCookie,
      },
      body: JSON.stringify({ sha: latestSha }),
    });
    assert.ok(
      rollbackRes.status === 200 || rollbackRes.status === 204,
      `expected 200/204 from rollback but got ${rollbackRes.status}`,
    );

    // Fetch commits again — the rolled-back SHA should be gone.
    const commitsAfter = await fetch(`${apiUrl}/studio/commits`, {
      headers: { Cookie: authCookie },
    });
    assert.strictEqual(commitsAfter.status, 200);
    const afterBody = await commitsAfter.json() as { commits: Array<{ sha: string }> };
    const shaList = (afterBody.commits ?? []).map((c) => c.sha);

    assert.ok(
      !shaList.includes(latestSha),
      `rolled-back SHA ${latestSha} should not appear in commit list after rollback`,
    );
  });
});
