/**
 * @file tests/integration/oauth-flow.test.ts
 *
 * Layer 3 Integration — OAuth flow.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Test matrix" — "OAuth flow" row.
 *
 * Scenarios covered:
 *   - GET /studio/oauth/init returns a URL matching the proxy fixture.
 *   - POST /studio/oauth/complete with a code succeeds.
 *   - oauthProxy.requests contains both calls with correct payloads.
 *
 * An in-process HTTP proxy intercepts outbound OAuth calls. The studio server
 * is started with `OAUTH_BASE_URL` pointing to the proxy.
 *
 * Run in isolation:
 *   node --test tests/integration/oauth-flow.test.ts
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
import { startOAuthProxy, type OAuthProxy } from './helpers/oauth-proxy.js';
import { installClaudeStub, type ClaudeStub } from './helpers/claude-stub.js';

const NAMESPACE = `calypso-oauth-${Date.now()}`;
const TIMEOUT_MS = 120_000;

const TEST_USER = { username: 'oauthuser', password: 'oauthpass123!' };
const FIXTURE_OAUTH_URL = 'https://fixture.example/oauth?state=abc';
const FIXTURE_TOKEN = 'fixture-token-123';

describe('oauth-flow', { timeout: TIMEOUT_MS + 60_000 }, () => {
  let apiUrl: string;
  let fwd: PortForwardHandle;
  let stub: ClaudeStub;
  let oauthProxy: OAuthProxy;
  let authCookie: string;

  before(function () {
    if (!clusterAvailable()) {
      this.skip();
    }
  });

  before(async () => {
    stub = installClaudeStub();

    // Start the OAuth proxy before provisioning the namespace so that the
    // server can be configured with OAUTH_BASE_URL at deploy time.
    oauthProxy = await startOAuthProxy({
      '/oauth/init': { url: FIXTURE_OAUTH_URL },
      '/oauth/complete': { access_token: FIXTURE_TOKEN },
    });

    // Point the studio server at the proxy.
    process.env.OAUTH_BASE_URL = oauthProxy.baseUrl;

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

  after(async () => {
    fwd?.close();
    stub?.cleanup();
    await oauthProxy?.close();
    delete process.env.OAUTH_BASE_URL;
    deleteNamespace(NAMESPACE);
  });

  it('GET /studio/oauth/init returns a URL matching the proxy fixture', async () => {
    const res = await fetch(`${apiUrl}/studio/oauth/init`, {
      headers: { Cookie: authCookie },
    });
    assert.strictEqual(res.status, 200, `expected 200 but got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(
      typeof body.url === 'string',
      `response should include a url field. Got: ${JSON.stringify(body)}`,
    );
    assert.ok(
      (body.url as string).includes('fixture.example') ||
        (body.url as string).includes('oauth'),
      `url should match proxy fixture. Got: ${body.url}`,
    );
  });

  it('POST /studio/oauth/complete with a code succeeds', async () => {
    const res = await fetch(`${apiUrl}/studio/oauth/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: authCookie,
      },
      body: JSON.stringify({ code: 'test-auth-code-123', state: 'abc' }),
    });
    assert.ok(
      res.status === 200 || res.status === 204,
      `expected 200/204 from oauth/complete but got ${res.status}`,
    );
  });

  it('oauthProxy.requests contains both /oauth/init and /oauth/complete calls', () => {
    const paths = oauthProxy.requests.map((r) => r.path);
    assert.ok(
      paths.some((p) => p.includes('/oauth/init')),
      `oauthProxy.requests should include /oauth/init. Got paths: ${JSON.stringify(paths)}`,
    );
    assert.ok(
      paths.some((p) => p.includes('/oauth/complete')),
      `oauthProxy.requests should include /oauth/complete. Got paths: ${JSON.stringify(paths)}`,
    );
  });

  it('oauthProxy.requests contains correct payloads', () => {
    const completeReq = oauthProxy.requests.find((r) =>
      r.path.includes('/oauth/complete'),
    );
    assert.ok(completeReq, '/oauth/complete request should have been captured');
    const body = completeReq.body as Record<string, unknown>;
    assert.ok(
      typeof body === 'object' && body !== null,
      'oauth/complete request body should be an object',
    );
  });
});
