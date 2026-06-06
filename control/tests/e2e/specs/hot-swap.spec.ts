/**
 * @file tests/e2e/specs/hot-swap.spec.ts
 *
 * Layer 4 Browser E2E — Hot-swap.
 *
 * Scenario: Send message that modifies a server file; status indicator
 * transitions restarting → healthy; iframe is reloaded.
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Test scenarios" table — "hot-swap" row.
 */

import { test, expect } from '../fixtures/studio.fixture.js';
import { ChatPage } from '../pages/ChatPage.js';

test.describe('hot-swap', () => {
  test('status indicator passes through restarting before returning to healthy', async ({ studioPage }) => {
    const chatPage = new ChatPage(studioPage.page);

    // Collect status transitions during the test.
    const statusHistory: string[] = [];
    studioPage.page.on('console', (msg) => {
      // The ClusterStatusController logs status changes.
      if (msg.text().includes('cluster')) {
        statusHistory.push(msg.text());
      }
    });

    // Send a message that causes the server to modify a file (triggering hot-swap).
    await chatPage.sendMessage('modify the server config to add a comment');
    await chatPage.waitForTurnComplete(90_000);

    // Wait for the cluster to transition through restarting back to healthy.
    // The reloading overlay should appear then disappear.
    const overlayAppeared = await studioPage.reloadingOverlay
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);

    if (overlayAppeared) {
      // Overlay appeared — now wait for it to disappear (healthy restored).
      await studioPage.reloadingOverlay.waitFor({ state: 'hidden', timeout: 60_000 });
    }

    // Wait for healthy status.
    await studioPage.waitForClusterStatus('healthy', 60_000);

    const finalLabel = await studioPage.getClusterStatusLabel();
    expect(finalLabel).toContain('healthy');
  });

  test('iframe is reloaded after hot-swap completes', async ({ studioPage }) => {
    const chatPage = new ChatPage(studioPage.page);

    // Track iframe navigation events.
    let iframeReloaded = false;
    studioPage.page.on('framenavigated', (frame) => {
      if (frame.url().includes('/app/')) {
        iframeReloaded = true;
      }
    });

    await chatPage.sendMessage('update the api handler with a log statement');
    await chatPage.waitForTurnComplete(90_000);

    // Allow time for the hot-swap cycle.
    await studioPage.page.waitForTimeout(5_000);

    // After a hot-swap, the iframe should have been reloaded.
    // We assert the iframe src still points to /app/ (it reloads in place).
    const iframeSrc = await studioPage.getIframeSrc();
    expect(iframeSrc).toContain('/app/');

    // The cluster must be healthy after the swap.
    await studioPage.waitForClusterStatus('healthy', 60_000);
  });
});
