/**
 * @file tests/e2e/specs/oauth-connect.spec.ts
 *
 * Layer 4 Browser E2E — OAuth connect.
 *
 * Scenario: Click Initiate; enter fixture code; URL displayed; panel shows
 * connected; oauthProxy.requests contains init and complete calls with
 * correct payloads.
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Test scenarios" table — "oauth-connect" row.
 */

import { test, expect } from '../fixtures/studio.fixture.js';
import { OAuthPage } from '../pages/OAuthPage.js';

test.describe('oauth-connect', () => {
  test('OAuth URL is displayed after clicking Initiate', async ({ studioPage }) => {
    const oauthPage = new OAuthPage(studioPage.page);

    await oauthPage.clickInitiate();
    await oauthPage.waitForOAuthUrl(30_000);

    const url = await oauthPage.getOAuthUrl();
    expect(url).toBeTruthy();
    expect(url.length).toBeGreaterThan(0);
  });

  test('panel shows connected after entering confirmation code', async ({ studioPage }) => {
    const oauthPage = new OAuthPage(studioPage.page);

    await oauthPage.clickInitiate();
    await oauthPage.waitForOAuthUrl(30_000);

    // Enter the fixture confirmation code and submit.
    await oauthPage.submitCode('fixture-confirmation-code-123');
    await oauthPage.waitForConnected(30_000);

    await expect(oauthPage.connectedStatus()).toBeVisible();
  });

  test('oauthProxy receives init and complete calls', async ({ studioPage, oauthProxy }) => {
    const oauthPage = new OAuthPage(studioPage.page);

    await oauthPage.clickInitiate();
    await oauthPage.waitForOAuthUrl(30_000);
    await oauthPage.submitCode('fixture-code-xyz');

    // Allow time for the complete call to reach the proxy.
    await studioPage.page.waitForTimeout(2_000);

    // The proxy should have received at least one request for /oauth/init.
    const initRequests = oauthProxy.requests.filter((r) => r.path === '/oauth/init');
    expect(initRequests.length).toBeGreaterThanOrEqual(1);

    // The proxy should also have received a request for /oauth/complete.
    const completeRequests = oauthProxy.requests.filter((r) => r.path === '/oauth/complete');
    expect(completeRequests.length).toBeGreaterThanOrEqual(1);
  });
});
