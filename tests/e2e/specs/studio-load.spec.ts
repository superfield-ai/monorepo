/**
 * @file tests/e2e/specs/studio-load.spec.ts
 *
 * Layer 4 Browser E2E — Studio load.
 *
 * Scenario: Navigate to /; studio panel visible; iframe loads /app/;
 * cluster status indicator shows healthy.
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Test scenarios" table — "studio-load" row.
 */

import { test, expect } from '../fixtures/studio.fixture.js';
import { StudioPage } from '../pages/StudioPage.js';

test.describe('studio-load', () => {
  test('studio panel is visible after navigation', async ({ studioPage }) => {
    await expect(studioPage.studioPanel).toBeVisible();
  });

  test('app iframe src contains /app/', async ({ studioPage }) => {
    const src = await studioPage.getIframeSrc();
    expect(src).toContain('/app/');
  });

  test('cluster status indicator shows healthy', async ({ studioPage }) => {
    await studioPage.waitForClusterStatus('healthy', 60_000);
    const label = await studioPage.getClusterStatusLabel();
    expect(label).toContain('healthy');
  });
});
