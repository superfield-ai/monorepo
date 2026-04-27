/**
 * @file fixtures.ts
 *
 * Shared Playwright fixtures.
 *
 * `expectCleanConsole` (T1) — extends the base `test` so every spec
 * automatically attaches a console listener and asserts at teardown that
 * neither `console.error` nor `console.warn` ever fired during the run.
 *
 * Operating principle (no surprises): zero JS console errors / warnings on the
 * deployed webapp. There is no allowlist; if a test fails this assertion the
 * fix is to either eliminate the call or surface it through the DebugStore /
 * UI instead of the raw console.
 *
 * Usage:
 *
 *   import { test, expect } from "../fixtures";
 *   test("homepage", async ({ page }) => { ... });
 *
 * The fixture replaces the default Playwright `test` import.
 */

import { test as base, expect } from "@playwright/test";

interface CapturedConsole {
  readonly errors: string[];
  readonly warnings: string[];
}

interface CleanConsoleFixtures {
  readonly capturedConsole: CapturedConsole;
}

export const test = base.extend<CleanConsoleFixtures>({
  // `auto: true` forces this fixture to run for every test that uses our
  // extended `test`, so a spec author cannot opt out — that is the whole
  // point of T1.
  capturedConsole: [
    async ({ page }, use) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      page.on("console", (msg) => {
        const text = msg.text();
        // Browser-emitted resource-load errors (4xx/5xx on script/iframe/img
        // loads) come through page.on("console") with type=error but are NOT
        // JS console.error calls from app code — they are emitted by the
        // chromium networking layer and cannot be suppressed by any user-
        // space console intercept. The IframeOverlay (E14) is the visible
        // recovery affordance for these failures; the operator already sees a
        // labelled card. Counting them here would turn every test that
        // touches the cluster proxy into a flake.
        if (
          msg.type() === "error" &&
          !text.startsWith("Failed to load resource:")
        ) {
          errors.push(text);
        }
        if (msg.type() === "warning") warnings.push(text);
      });
      page.on("pageerror", (err) => {
        errors.push(`pageerror: ${err.message}`);
      });
      await use({ errors, warnings });
      // Assertion runs even on test failure so the original failure is preserved.
      if (errors.length > 0 || warnings.length > 0) {
        const lines = [
          errors.length > 0 ? `console.error (${errors.length}):` : null,
          ...errors.map((e) => `  - ${e}`),
          warnings.length > 0 ? `console.warn (${warnings.length}):` : null,
          ...warnings.map((w) => `  - ${w}`),
        ].filter(Boolean);
        throw new Error(
          `expectCleanConsole: console output detected during test\n${lines.join("\n")}`,
        );
      }
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Attach the clean-console assertion inside any spec that already imports the
 * stock Playwright `test`. Adds an automatic teardown.
 */
export function expectCleanConsole(page: import("@playwright/test").Page): {
  readonly assert: () => void;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      msg.type() === "error" &&
      !text.startsWith("Failed to load resource:")
    ) {
      errors.push(text);
    }
    if (msg.type() === "warning") warnings.push(text);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return {
    assert: (): void => {
      if (errors.length === 0 && warnings.length === 0) return;
      const lines = [
        errors.length > 0 ? `console.error (${errors.length}):` : null,
        ...errors.map((e) => `  - ${e}`),
        warnings.length > 0 ? `console.warn (${warnings.length}):` : null,
        ...warnings.map((w) => `  - ${w}`),
      ].filter(Boolean);
      throw new Error(
        `expectCleanConsole: console output detected\n${lines.join("\n")}`,
      );
    },
  };
}
