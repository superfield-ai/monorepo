/**
 * Vitest configuration for the web application.
 *
 * Defines two test projects (via the adjacent vitest.workspace.ts which is
 * auto-discovered by Vitest):
 *
 *  - `unit`      Layer 1b: headless Chromium unit tests for pure TypeScript
 *                controllers. No React plugin. Tests run in a real browser
 *                context so fetch, EventSource, and ReadableStream are genuine
 *                browser globals.
 *
 *  - `component` Layer 2: React component tests rendered into a real Chromium
 *                DOM. Uses @vitejs/plugin-react so JSX is transformed. Each
 *                test injects a fully-doubled mock controller — no real fetch
 *                calls reach a server.
 *
 * Run commands (from repo root):
 *   bun --bun vitest run --config apps/web/vitest.config.ts --project unit
 *   bun --bun vitest run --config apps/web/vitest.config.ts --project component
 *
 * Canonical docs: test-plan.md §Layer 1b (unit) / §Layer 2 (component).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Root Vite configuration for apps/web. Project definitions (unit and
  // component) are in vitest.workspace.ts (same directory) and are
  // auto-discovered by Vitest at startup.
});
