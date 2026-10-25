import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HiddenTest } from "../protocol/index.ts";

async function place(worktree: string, test: HiddenTest): Promise<void> {
  const segments = test.path.split("/");
  let directory = worktree;
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment);
    const found = await lstat(directory).catch(() => null);
    if (found?.isSymbolicLink()) throw new Error(`"${segment}" is a symbolic link in the verification worktree`);
    if (found === null) await mkdir(directory);
  }
  const target = join(worktree, ...segments);
  if ((await lstat(target).catch(() => null))?.isSymbolicLink()) {
    throw new Error("it is a symbolic link in the verification worktree");
  }
  await writeFile(target, test.content);
}

/**
 * Writes the hidden tests into the verification worktree. The worktree is built from the attempt's snapshot, so
 * what is already there is the attempt's doing; a symbolic link on the way to a hidden test would send the write
 * outside the worktree, so it is refused. A hidden test that cannot be placed is reported by its path.
 */
export async function introduceHiddenTests(worktree: string, tests: readonly HiddenTest[]): Promise<void> {
  for (const test of tests) {
    await place(worktree, test).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot place hidden test ${test.path}: ${reason}`, { cause: error });
    });
  }
}
