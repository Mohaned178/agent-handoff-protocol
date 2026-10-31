// `ahp "<task>"` runs the check once on the last commit before any agent starts, in a worktree of its own, as
// verification would. A check that already fails is often the task itself ("fix the failing test"), so it is said,
// not refused; but a check that cannot run at all (a missing tool, a typo) would spend every agent attempt for nothing,
// and the person sees it here first, for the cost of one run of the check.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { addWorktree, discardWorktree, installDependencies, prepareWorktreeRoot, runVerificationCommand } from "../runtime/index.ts";
import { failingLineOf } from "./receipt.ts";

export type Precheck = { passed: true } | { passed: false; line: string };

/** The check (after the install, if any) on `repo`'s HEAD, in a fresh worktree removed afterwards. */
export async function precheck(repo: string, check: string, install: string | null): Promise<Precheck> {
  const worktree = join(await prepareWorktreeRoot(), `precheck-${randomUUID().slice(0, 8)}`);
  try {
    await addWorktree(repo, worktree, "HEAD");
    if (install !== null) {
      try {
        await installDependencies(install, worktree);
      } catch (error) {
        return { passed: false, line: `the install failed: ${failingLineOf((error as Error).message)}` };
      }
    }
    const result = await runVerificationCommand(check, worktree);
    return result.exitCode === 0 ? { passed: true } : { passed: false, line: failingLineOf(result.output) };
  } finally {
    await discardWorktree(repo, worktree);
  }
}
