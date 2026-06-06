/**
 * @file tests/integration/cluster-events.test.ts
 *
 * Layer 3 Integration — Cluster events SSE.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Test matrix" — "Cluster events SSE" row.
 *
 * Scenarios covered:
 *   - GET /studio/cluster/events streams at least one pod SSE event.
 *   - Force-deleting a pod via kubectl produces a `restarting` event followed
 *     by a `healthy` event.
 *
 * Run in isolation:
 *   node --test tests/integration/cluster-events.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  clusterAvailable,
  createNamespace,
  deleteNamespace,
  applyManifests,
} from './helpers/cluster.js';
import { portForward, type PortForwardHandle } from './helpers/port-forward.js';
import { waitReady } from './helpers/wait-ready.js';
import { installClaudeStub, type ClaudeStub } from './helpers/claude-stub.js';

const NAMESPACE = `calypso-events-${Date.now()}`;
const TIMEOUT_MS = 120_000;

const TEST_USER = { username: 'eventsuser', password: 'eventspass123!' };

/** Collect SSE events from a stream for up to `timeoutMs` milliseconds. */
async function collectSseEvents(
  res: Response,
  maxEvents: number,
  timeoutMs: number,
): Promise<string[]> {
  const events: string[] = [];
  if (!res.body) return events;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline && events.length < maxEvents) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      const text = decoder.decode(value);
      events.push(text);
    }
  }

  reader.cancel().catch(() => {});
  return events;
}

describe('cluster-events', { timeout: TIMEOUT_MS + 60_000 }, () => {
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

  it('GET /studio/cluster/events delivers at least one pod SSE event', async () => {
    const res = await fetch(`${apiUrl}/studio/cluster/events`, {
      headers: {
        Cookie: authCookie,
        Accept: 'text/event-stream',
      },
    });

    assert.ok(
      res.headers.get('content-type')?.includes('text/event-stream'),
      'response should be text/event-stream',
    );

    const events = await collectSseEvents(res, 3, 15_000);
    assert.ok(
      events.length > 0,
      `should have received at least one SSE event. Got: ${events.join('')}`,
    );

    const combined = events.join('');
    // Cluster events should contain pod-related fields.
    assert.ok(
      combined.includes('data:'),
      `SSE events should contain data: lines. Got: ${combined}`,
    );
  });

  it('force-deleting a pod produces restarting then healthy events', async () => {
    const collectedEvents: string[] = [];

    // Open a persistent SSE connection.
    const res = await fetch(`${apiUrl}/studio/cluster/events`, {
      headers: {
        Cookie: authCookie,
        Accept: 'text/event-stream',
      },
    });

    assert.ok(res.body, 'response body should be a readable stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Collect events in background while we trigger the pod deletion.
    const collectPromise = (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          collectedEvents.push(decoder.decode(value));
        }
        // Stop once we have seen both expected events.
        const combined = collectedEvents.join('');
        if (combined.includes('restarting') && combined.includes('healthy')) {
          break;
        }
      }
    })();

    // Give the stream a moment to initialise, then force-delete a pod.
    await new Promise<void>((r) => setTimeout(r, 1_000));

    const getPodsResult = spawnSync(
      'kubectl',
      ['get', 'pods', '-n', NAMESPACE, '-o', 'name'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const pods = getPodsResult.stdout
      .trim()
      .split('\n')
      .filter((p) => p.startsWith('pod/api'));

    if (pods.length > 0) {
      const podName = pods[0].replace('pod/', '');
      spawnSync(
        'kubectl',
        ['delete', 'pod', podName, '-n', NAMESPACE, '--force', '--grace-period=0'],
        { encoding: 'utf8', timeout: 15_000 },
      );
    }

    await collectPromise;
    reader.cancel().catch(() => {});

    const combined = collectedEvents.join('');

    assert.ok(
      combined.includes('restarting'),
      `events should include a "restarting" event. Collected: ${combined}`,
    );
    assert.ok(
      combined.includes('healthy'),
      `events should include a "healthy" event after "restarting". Collected: ${combined}`,
    );

    // Verify ordering: restarting must appear before healthy.
    const restartingIdx = combined.indexOf('restarting');
    const healthyIdx = combined.lastIndexOf('healthy');
    assert.ok(
      restartingIdx < healthyIdx,
      '"restarting" event must precede the final "healthy" event',
    );
  });
});
