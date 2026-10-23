// Keeps every test's AHP worktrees in a temporary AHP_HOME instead of the real per-user location.
// CLI tests' child processes inherit it through the environment.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "ahp-home-"));
process.env.AHP_HOME = home;

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
