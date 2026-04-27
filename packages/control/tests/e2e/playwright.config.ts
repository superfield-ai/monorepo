/**
 * Playwright config for studio webapp E2E tests.
 *
 * Requires the web app to be built before running:
 *   bun run --cwd packages/control/apps build
 *
 * Then run:
 *   npx playwright test --config packages/control/tests/e2e/playwright.config.ts
 */
import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const E2E_ROOT = resolve(import.meta.dirname);

export default defineConfig({
  testDir: resolve(E2E_ROOT, "specs"),
  globalSetup: resolve(E2E_ROOT, "global-setup.ts"),
  globalTeardown: resolve(E2E_ROOT, "global-teardown.ts"),
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${process.env.CONTROL_E2E_PORT ?? "7009"}`,
    headless: true,
    trace: "retain-on-failure",
  },
  reporter: [["html", { open: "never" }], ["line"]],
});
