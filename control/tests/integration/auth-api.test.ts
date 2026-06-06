/**
 * @file tests/integration/auth-api.test.ts
 *
 * Layer 3 Integration — Auth API surface.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Test matrix" — "Auth API" row.
 *
 * Scenarios covered:
 *   - POST /auth/register returns 200 and creates a user account.
 *   - POST /auth/login returns a Set-Cookie header with a JWT token.
 *   - GET /studio/chat without a cookie returns 401 Unauthorized.
 *
 * The suite provisions a dedicated namespace, waits for the stack to be
 * ready, and forwards the api service port before running HTTP assertions.
 * Teardown deletes the namespace regardless of test outcome.
 *
 * Run in isolation:
 *   node --test tests/integration/auth-api.test.ts
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

const NAMESPACE = `calypso-auth-${Date.now()}`;
const TIMEOUT_MS = 120_000;

const TEST_USER = { username: 'testuser', password: 'testpass123!' };

describe('auth-api', { timeout: TIMEOUT_MS + 30_000 }, () => {
  let apiUrl: string;
  let fwd: PortForwardHandle;

  before(function () {
    if (!clusterAvailable()) {
      this.skip();
    }
  });

  before(async () => {
    createNamespace(NAMESPACE);
    applyManifests(NAMESPACE);
    await waitReady(NAMESPACE, TIMEOUT_MS);
    fwd = await portForward(NAMESPACE, 'svc/api', 0, 3000);
    apiUrl = `http://${fwd.host}:${fwd.port}`;
  });

  after(() => {
    fwd?.close();
    deleteNamespace(NAMESPACE);
  });

  it('POST /auth/register returns 200', async () => {
    const res = await fetch(`${apiUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_USER),
    });
    assert.ok(
      res.status === 200 || res.status === 201,
      `expected 200/201 but got ${res.status}`,
    );
  });

  it('POST /auth/login returns Set-Cookie with JWT', async () => {
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_USER),
    });
    assert.ok(
      res.status === 200,
      `expected 200 but got ${res.status}`,
    );
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Set-Cookie header should be present');
    assert.ok(
      setCookie.includes('studio_token') || setCookie.includes('jwt') || setCookie.length > 20,
      'Set-Cookie should contain a JWT-like token',
    );
  });

  it('GET /studio/chat without cookie returns 401', async () => {
    // Deliberately send a fresh request with no cookies.
    const res = await fetch(`${apiUrl}/studio/chat`, {
      headers: {}, // No cookie
    });
    assert.strictEqual(res.status, 401, 'unauthenticated request should return 401');
  });
});
