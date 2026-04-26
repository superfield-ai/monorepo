import { defineConfig } from "vitest/config";
import { resolve } from "path";

const pkgRoot = resolve(import.meta.dirname);

export default defineConfig({
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
