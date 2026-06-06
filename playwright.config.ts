/**
 * @file playwright.config.ts
 *
 * Playwright configuration for Layer 4 Browser E2E tests.
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Playwright config" section.
 *
 * Run command: npx playwright test
 *
 * Spec files live under tests/e2e/specs/. Each spec exercises a complete
 * user journey through the real headless Chromium browser against a
 * provisioned k3s cluster with claudeStub and oauthProxy.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e/specs',
  // Only the sanity spec runs until the full suite is stable in CI.
  // Remove this line to re-enable all specs.
  testMatch: ['**/sanity.spec.ts'],
  timeout: 120_000,
  workers: 1,
  use: {
    headless: true,
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: [['html', { open: 'never' }]],
});
