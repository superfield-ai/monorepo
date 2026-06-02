import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests spawn a real tsserver subprocess; allow up to 30 s per test.
    testTimeout: 30_000,
  },
});
