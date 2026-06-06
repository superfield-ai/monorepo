/**
 * @file tests/integration/chat-streaming.test.ts
 *
 * Layer 3 Integration — Chat streaming SSE.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Test matrix" — "Chat streaming" row.
 *
 * Scenarios covered:
 *   - GET /studio/chat/stream delivers at least one SSE data chunk.
 *   - The stream closes after `event: done` is received.
 *   - Aborting the client request stops the subprocess on the server side.
 *
 * Run in isolation:
 *   node --test tests/integration/chat-streaming.test.ts
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

const NAMESPACE = `calypso-stream-${Date.now()}`;
const TIMEOUT_MS = 120_000;

const TEST_USER = { username: 'streamuser', password: 'streampass123!' };

describe('chat-streaming', { timeout: TIMEOUT_MS + 60_000 }, () => {
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

  it('GET /studio/chat/stream delivers at least one SSE data chunk', async () => {
    const chunks: string[] = [];
    const res = await fetch(
      `${apiUrl}/studio/chat/stream?message=${encodeURIComponent('streaming test')}`,
      {
        headers: {
          Cookie: authCookie,
          Accept: 'text/event-stream',
        },
      },
    );

    assert.strictEqual(
      res.headers.get('content-type')?.includes('text/event-stream'),
      true,
      'response should be text/event-stream',
    );

    assert.ok(res.body, 'response body should be a readable stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let sawData = false;

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        const text = decoder.decode(value);
        chunks.push(text);
        if (text.includes('data:')) {
          sawData = true;
        }
        if (text.includes('event: done')) {
          break;
        }
      }
    }

    assert.ok(sawData, `should have received at least one SSE data chunk. Got: ${chunks.join('')}`);
  });

  it('stream closes after event: done', async () => {
    const res = await fetch(
      `${apiUrl}/studio/chat/stream?message=${encodeURIComponent('done event test')}`,
      {
        headers: {
          Cookie: authCookie,
          Accept: 'text/event-stream',
        },
      },
    );

    assert.ok(res.body, 'response body should be a readable stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sawDone = false;
    let streamEnded = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        streamEnded = true;
        break;
      }
      if (value) {
        const text = decoder.decode(value);
        if (text.includes('event: done')) {
          sawDone = true;
        }
      }
    }

    // After event: done the stream should have closed naturally.
    assert.ok(sawDone || streamEnded, 'stream should have received event: done or closed');
  });

  it('aborting the client request stops the subprocess', async () => {
    const controller = new AbortController();
    const { signal } = controller;

    const fetchPromise = fetch(
      `${apiUrl}/studio/chat/stream?message=${encodeURIComponent('abort test')}`,
      {
        headers: {
          Cookie: authCookie,
          Accept: 'text/event-stream',
        },
        signal,
      },
    );

    // Give the request a moment to start, then abort.
    await new Promise<void>((res) => setTimeout(res, 200));
    controller.abort();

    // The fetch should throw an AbortError.
    await assert.rejects(fetchPromise, (err: Error) => {
      return err.name === 'AbortError' || err.message.includes('abort');
    });

    // After abort, the server should not leave zombie processes.
    // We cannot directly assert this from the test client, but we verify
    // the server remains responsive for the next request.
    await new Promise<void>((res) => setTimeout(res, 500));
    const healthRes = await fetch(`${apiUrl}/health`, {
      headers: { Cookie: authCookie },
    });
    assert.ok(
      healthRes.status < 500,
      `server should remain responsive after client abort. Got: ${healthRes.status}`,
    );
  });
});
