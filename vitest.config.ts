import { defineConfig } from "vitest/config";

const WINDOWS_CI = process.platform === "win32" && process.env.CI !== undefined;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/helpers/setup.ts"],
    // Tests drive real git and real child processes, which are slow on Windows. GitHub's hosted Windows runner is slower
    // still, and unevenly: in run 41143276777 tests that took 7 to 12 s in run 41141606519 took 56 to 63 s (the whole
    // runner slowed, not one test), so there a test gets three minutes. A hang still fails, only later.
    testTimeout: WINDOWS_CI ? 180_000 : 60_000,
    hookTimeout: WINDOWS_CI ? 180_000 : 60_000,
  },
});
