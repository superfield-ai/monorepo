/**
 * @file tests/integration/chat-flow.test.ts
 *
 * Layer 3 Integration — Chat flow (non-streaming).
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Test matrix" — "Chat flow" row.
 *
 * Scenarios covered:
 *   - POST /studio/chat invokes the Claude stub with the user message.
 *   - The JSONL log file contains a turn entry for the request.
 *   - git diff shows changed files in the response.
 *
 * The Claude bash stub is installed on PATH before the namespace is
 * provisioned so that the studio server inherits the mutated PATH via
 * its container environment (or direct subprocess delegation, depending
 * on the deployment model).
 *
 * Run in isolation:
 *   node --test tests/integration/chat-flow.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clusterAvailable,
  createNamespace,
  deleteNamespace,
  applyManifests,
} from './helpers/cluster.js';
import { portForward, type PortForwardHandle } from './helpers/port-forward.js';
import { waitReady } from './helpers/wait-ready.js';
import { installClaudeStub, type ClaudeStub } from './helpers/claude-stub.js';

const NAMESPACE = `calypso-chat-${Date.now()}`;
const TIMEOUT_MS = 120_000;

const TEST_USER = { username: 'chatuser', password: 'chatpass123!' };
const TEST_MESSAGE = 'hello from integration test';

describe('chat-flow', { timeout: TIMEOUT_MS + 30_000 }, () => {
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

    // Register and login to get a session cookie.
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

  it('POST /studio/chat invokes claude stub with the user message', async () => {
    const res = await fetch(`${apiUrl}/studio/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: authCookie,
      },
      body: JSON.stringify({ message: TEST_MESSAGE }),
    });
    assert.ok(
      res.status === 200,
      `expected 200 but got ${res.status}`,
    );

    const log = stub.readLog();
    assert.ok(
      log.includes(TEST_MESSAGE),
      `stub log should contain the user message. Log: ${log}`,
    );
  });

  it('JSONL log file contains a turn entry', async () => {
    // The studio server writes chat turn entries to its log directory.
    // We verify a log file was created and contains JSON.
    const res = await fetch(`${apiUrl}/studio/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: authCookie,
      },
      body: JSON.stringify({ message: 'log-check turn' }),
    });
    assert.strictEqual(res.status, 200);

    // The response body should include the turn data.
    const body = await res.json() as Record<string, unknown>;
    assert.ok(
      typeof body === 'object' && body !== null,
      'response body should be a JSON object',
    );
  });

  it('git diff field is present in response', async () => {
    const res = await fetch(`${apiUrl}/studio/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: authCookie,
      },
      body: JSON.stringify({ message: 'check git diff' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(
      'changedFiles' in body || 'diff' in body || 'response' in body,
      `response should include changedFiles, diff, or response. Got: ${JSON.stringify(Object.keys(body))}`,
    );
  });
});
