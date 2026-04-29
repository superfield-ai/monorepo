import { defineConfig } from "vitest/config";
import { resolve } from "path";

const pkgRoot = resolve(import.meta.dirname);
const coreRoot = resolve(pkgRoot, "../core");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@superfield\/core\/api-state$/,
        replacement: resolve(coreRoot, "api-state.ts"),
      },
      {
        find: /^@superfield\/core\/api-server$/,
        replacement: resolve(coreRoot, "api-server.ts"),
      },
      {
        find: /^@superfield\/core$/,
        replacement: resolve(coreRoot, "index.ts"),
      },
      {
        find: /^@superfield\/github$/,
        replacement: resolve(pkgRoot, "../github/index.ts"),
      },
      {
        find: /^@superfield\/git$/,
        replacement: resolve(pkgRoot, "../git/index.ts"),
      },
      {
        find: /^@superfield\/control-core$/,
        replacement: resolve(pkgRoot, "../control-core/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    root: pkgRoot,
    include: [`${pkgRoot}/tests/**/*.test.ts`],
    setupFiles: [
      resolve(pkgRoot, "../../tests/test-env.ts"),
      `${pkgRoot}/tests/helpers/bun-shim.ts`,
    ],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
