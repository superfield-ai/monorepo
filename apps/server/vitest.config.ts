import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const serverRoot = resolve(import.meta.dirname);

export default defineConfig({
  test: {
    environment: 'node',
    root: serverRoot,
    include: [`${serverRoot}/tests/**/*.test.ts`],
    setupFiles: [`${serverRoot}/tests/helpers/bun-shim.ts`],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
