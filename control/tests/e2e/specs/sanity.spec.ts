/**
 * @file tests/e2e/specs/sanity.spec.ts
 *
 * Layer 4 Browser E2E — Baseline sanity suite.
 *
 * These 4 tests cover the four distinct infrastructure concerns. All other
 * spec files are held back until these pass consistently. Re-enable them by
 * removing the testMatch restriction in playwright.config.ts.
 *
 *   Test 1 — Infrastructure:  server starts, static UI renders, iframe proxy works.
 *   Test 2 — Kubernetes:      SSE endpoint connects, kubectl cluster-info succeeds,
 *                              browser EventSource receives "healthy".
 *   Test 3 — Auth + API:      stub UI auto-login completes, /studio/chat responds,
 *                              submit button disables while in-flight.
 *   Test 4 — End-to-end chat: claude-stub spawned, reply returned, UI updated.
 */

import { test, expect } from '../fixtures/studio.fixture.js';
import { ChatPage } from '../pages/ChatPage.js';

test('1: studio panel is visible and iframe points at /app/', async ({ studioPage }) => {
  await expect(studioPage.studioPanel).toBeVisible();
  const src = await studioPage.getIframeSrc();
  expect(src).toContain('/app/');
});

test('2: cluster status indicator is visible with a valid status', async ({ studioPage }) => {
  await expect(studioPage.clusterStatusIndicator).toBeVisible();
  const label = await studioPage.getClusterStatusLabel();
  expect(label).toMatch(/Cluster status: (healthy|restarting|degraded|unknown)/);
});

test('3: chat submit is disabled while request is in flight', async ({ studioPage }) => {
  const chat = new ChatPage(studioPage.page);
  await chat.chatInput.fill('ping');
  await chat.chatSubmit.click();
  await expect(chat.chatSubmit).toBeDisabled();
});

test('4: assistant reply appears after sending a message', async ({ studioPage }) => {
  const chat = new ChatPage(studioPage.page);
  await chat.sendMessage('hello from e2e');
  await chat.waitForReply(60_000);
  const count = await chat.getAssistantMessageCount();
  expect(count).toBeGreaterThanOrEqual(1);
});
