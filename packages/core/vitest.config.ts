import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@superfield/github": path.resolve(__dirname, "../github/index.ts"),
      "@superfield/git": path.resolve(__dirname, "../git/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: [path.resolve(__dirname, "../../tests/test-env.ts")],
  },
});
