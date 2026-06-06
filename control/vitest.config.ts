import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/server/tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['apps/server/tests/helpers/bun-shim.ts'],
    coverage: {
      provider: 'v8',
      include: ['apps/server/src/**', 'packages/core/src/**'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
      },
    },
  },
});
