import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/helpers/setup.ts"],
    // Tests drive real git and real child processes, which are slow on Windows.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
