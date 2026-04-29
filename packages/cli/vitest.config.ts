import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@superfield/core/loops/dev-loop",
        replacement: path.resolve(__dirname, "../core/loops/dev-loop.ts"),
      },
      {
        find: "@superfield/core/loops/doc-loop",
        replacement: path.resolve(__dirname, "../core/loops/doc-loop.ts"),
      },
      {
        find: "@superfield/core/api-state",
        replacement: path.resolve(__dirname, "../core/api-state.ts"),
      },
      {
        find: "@superfield/core/api-server",
        replacement: path.resolve(__dirname, "../core/api-server.ts"),
      },
      {
        find: "@superfield/core",
        replacement: path.resolve(__dirname, "../core/index.ts"),
      },
      {
        find: "@superfield/git",
        replacement: path.resolve(__dirname, "../git/index.ts"),
      },
      {
        find: "@superfield/github",
        replacement: path.resolve(__dirname, "../github/index.ts"),
      },
      {
        find: "@superfield/control-core",
        replacement: path.resolve(__dirname, "../control-core/index.ts"),
      },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: [path.resolve(__dirname, "../../tests/test-env.ts")],
  },
});
