import { defineConfig } from "vitest/config";
import { resolve } from "path";

const pkgRoot = resolve(import.meta.dirname);
const coreRoot = resolve(pkgRoot, "../core");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@superfield/core/api-state",
        replacement: resolve(coreRoot, "api-state.ts"),
      },
      {
        find: "@superfield/core/api-server",
        replacement: resolve(coreRoot, "api-server.ts"),
      },
      {
        find: "@superfield/core",
        replacement: resolve(coreRoot, "index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    root: pkgRoot,
    include: [`${pkgRoot}/tests/**/*.test.ts`],
    setupFiles: [`${pkgRoot}/tests/helpers/bun-shim.ts`],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
