/**
 * @file tests/e2e/fixtures/studio.fixture.ts
 *
 * Playwright fixture that provisions a k8s cluster and starts the studio
 * server with claudeStub and oauthProxy, then tears everything down even
 * when a test fails.
 *
 * Shared helpers from tests/integration/helpers/ are reused to keep the
 * cluster lifecycle consistent between Layer 3 and Layer 4 tests.
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Shared Playwright fixture" section.
 *
 * ## Cluster availability
 *
 * Tests that depend on `studioPage` or `serverUrl` require a reachable k3s
 * cluster. The fixture calls `clusterAvailable()` (runs
 * `kubectl cluster-info --request-timeout=3s`) and throws a hard error if no
 * cluster is found, causing the test to fail. In CI the `ci-e2e.yml` workflow
 * provisions a cluster via `nolar/setup-k3d-k3s` before this fixture runs.
 *
 * Usage:
 *
 *   import { test } from '../fixtures/studio.fixture';
 *   import { StudioPage } from '../pages/StudioPage';
 *
 *   test('studio loads', async ({ studioPage }) => {
 *     await studioPage.studioPanel.waitFor({ state: 'visible' });
 *   });
 */

import { test as base, expect } from '@playwright/test';
import {
  clusterAvailable,
  createNamespace,
  deleteNamespace,
  applyManifests,
  capturePodLogs,
} from '../../integration/helpers/cluster.js';
import { portForward, type PortForwardHandle } from '../../integration/helpers/port-forward.js';
import { waitReady } from '../../integration/helpers/wait-ready.js';
import {
  installClaudeStub,
  type ClaudeStub,
} from '../../integration/helpers/claude-stub.js';
import { startOAuthProxy, type OAuthProxy } from '../../integration/helpers/oauth-proxy.js';
import { StudioPage } from '../pages/StudioPage.js';

/** Unique namespace suffix per test file invocation. */
const NAMESPACE_BASE = `calypso-e2e-${Date.now()}`;

/** Context shared between fixture setup and teardown. */
interface ClusterContext {
  namespace: string;
  fwd: PortForwardHandle;
  stub: ClaudeStub;
  oauthProxy: OAuthProxy;
  serverUrl: string;
}

/**
 * Provision a k3s namespace, apply the Calypso overlay, and start helpers.
 *
 * @param namespace  k8s namespace to provision.
 * @param timeout    Maximum wait for deployments to become ready.
 */
async function provisionCluster(namespace: string, timeout: number): Promise<ClusterContext> {
  // Install the Claude stub so the studio server uses it.
  const stub = installClaudeStub();

  // OAuth proxy routes — provide both init and complete endpoints.
  const oauthProxy = await startOAuthProxy({
    '/oauth/init': {
      url: 'https://claude.ai/oauth/authorize?state=fixture-state-abc&client_id=fixture',
    },
    '/oauth/complete': {
      access_token: 'fixture-access-token-xyz',
      token_type: 'Bearer',
    },
  });
  process.env.OAUTH_BASE_URL = oauthProxy.baseUrl;

  createNamespace(namespace);
  applyManifests(namespace);
  await waitReady(namespace, timeout);

  const fwd = await portForward(namespace, 'svc/api', 0, 3000);
  const serverUrl = `http://${fwd.host}:${fwd.port}`;

  return { namespace, fwd, stub, oauthProxy, serverUrl };
}

/**
 * Tear down the cluster context. Errors are swallowed so afterAll/fixture
 * teardown always completes cleanly.
 */
async function teardownCluster(ctx: ClusterContext): Promise<void> {
  ctx.fwd?.close();
  ctx.stub?.cleanup();
  await ctx.oauthProxy?.close().catch((err: unknown) => {
    console.error('[studio.fixture] oauthProxy.close() failed:', err);
  });
  // Capture pod logs before deleting the namespace so CI can upload them.
  capturePodLogs(ctx.namespace);
  deleteNamespace(ctx.namespace);
}

// ---------------------------------------------------------------------------
// Custom fixture type
// ---------------------------------------------------------------------------

export interface StudioFixtures {
  /** A fully-loaded StudioPage pointing at the provisioned studio server. */
  studioPage: StudioPage;
  /** The provisioned cluster URL (e.g. for direct HTTP calls). */
  serverUrl: string;
  /** The OAuthProxy instance for capturing and asserting OAuth requests. */
  oauthProxy: OAuthProxy;
  /** The ClaudeStub instance for reading invocation logs. */
  claudeStub: ClaudeStub;
}

export const test = base.extend<StudioFixtures>({
  studioPage: async ({ page }, use) => {
    if (!clusterAvailable()) {
      throw new Error('No k3s cluster available — ensure k3s is running before running E2E tests');
    }

    const namespace = `${NAMESPACE_BASE}-${Math.random().toString(36).slice(2, 8)}`;
    let ctx: ClusterContext | undefined;

    try {
      ctx = await provisionCluster(namespace, 120_000);
      await page.goto(ctx.serverUrl);
      await use(new StudioPage(page));
    } finally {
      if (ctx) {
        await teardownCluster(ctx);
      }
    }
  },

  serverUrl: async ({ page: _page }, use) => {
    if (!clusterAvailable()) {
      throw new Error('No k3s cluster available — ensure k3s is running before running E2E tests');
    }

    const namespace = `${NAMESPACE_BASE}-srv-${Math.random().toString(36).slice(2, 8)}`;
    let ctx: ClusterContext | undefined;
    try {
      ctx = await provisionCluster(namespace, 120_000);
      await use(ctx.serverUrl);
    } finally {
      if (ctx) await teardownCluster(ctx);
    }
  },

  oauthProxy: async ({ page: _page }, use) => {
    // Standalone OAuth proxy for specs that need to inspect captured requests.
    const proxy = await startOAuthProxy({
      '/oauth/init': {
        url: 'https://claude.ai/oauth/authorize?state=fixture-state-abc&client_id=fixture',
      },
      '/oauth/complete': {
        access_token: 'fixture-access-token-xyz',
        token_type: 'Bearer',
      },
    });
    await use(proxy);
    await proxy.close().catch(() => undefined);
  },

  claudeStub: async ({ page: _page }, use) => {
    // Standalone stub for specs that need to read invocation logs.
    const stub = installClaudeStub();
    await use(stub);
    stub.cleanup();
  },
});

export { expect };
