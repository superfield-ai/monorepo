import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@superfield/db": path.resolve(__dirname, "../db/index.ts"),
      "@superfield/github": path.resolve(__dirname, "../github/index.ts"),
      "@superfield/git": path.resolve(__dirname, "../git/index.ts"),
      "@superfield/control-core": path.resolve(
        __dirname,
        "../control-core/index.ts",
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: [path.resolve(__dirname, "../../tests/test-env.ts")],
  },
});
