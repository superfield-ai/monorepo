/**
 * Vitest workspace configuration — defines the unit and component projects.
 *
 * This file is auto-discovered by Vitest when running:
 *   bun --bun vitest run --config apps/web/vitest.config.ts --project unit
 *   bun --bun vitest run --config apps/web/vitest.config.ts --project component
 *
 * Two projects:
 *  - `unit`      Layer 1b: headless Chromium unit tests for pure TypeScript
 *                controllers. No React plugin.
 *  - `component` Layer 2: React component tests in headless Chromium with
 *                @vitejs/plugin-react for JSX transform. Uses mock controllers
 *                — no real fetch calls.
 *
 * @vitejs/plugin-react is loaded via createRequire to ensure the version
 * installed in apps/web/node_modules (vite ≥4.2) is used, not a potentially
 * incompatible version from the monorepo root node_modules.
 *
 * Canonical docs: test-plan.md §Layer 1b / §Layer 2.
 */
import { defineWorkspace } from "vitest/config";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// Derive the apps/web root from this file's URL so include paths are absolute
// and work correctly regardless of the CWD used to invoke vitest.
const webRoot = dirname(fileURLToPath(import.meta.url));

// Load @vitejs/plugin-react from apps/web/node_modules via createRequire so the
// version compatible with vite@5 is used (apps/web has @vitejs/plugin-react@4.x).
const require = createRequire(import.meta.url);

const reactPluginModule = require("@vitejs/plugin-react") as
  | { default?: () => unknown }
  | (() => unknown);
const react =
  typeof reactPluginModule === "function"
    ? reactPluginModule
    : (reactPluginModule as { default: () => unknown }).default;

export default defineWorkspace([
  {
    // Layer 1b: browser controller unit tests (no React plugin needed)
    test: {
      name: "unit",
      root: webRoot,
      include: [resolve(webRoot, "tests/unit/**/*.test.ts")],
      setupFiles: [resolve(webRoot, "../../../tests/test-env.ts")],
      browser: {
        enabled: true,
        provider: "playwright",
        headless: true,
        name: "chromium",
      },
    },
  },
  {
    // Layer 2: React component tests (requires React plugin for JSX)
    plugins: [react()],
    test: {
      name: "component",
      root: webRoot,
      include: [resolve(webRoot, "tests/component/**/*.test.tsx")],
      setupFiles: [resolve(webRoot, "../../../tests/test-env.ts")],
      browser: {
        enabled: true,
        provider: "playwright",
        headless: true,
        name: "chromium",
      },
    },
  },
]);
