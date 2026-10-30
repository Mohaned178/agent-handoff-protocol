// `ahp demo`: the reference scenario in a sample project AHP makes for it, with a local bare repository standing in for
// the remote, so trying AHP needs no project, no remote and no setup. Nothing of the user's is touched: the project and
// its remote are made under AHP's own directory and kept there, for `ahp inspect` to read afterwards.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BRANCH, DEFAULT_WORKFLOW_FILE, renderWorkflow, type RoleAssignment } from "../doctor/init.ts";
import { DEFAULT_REMOTE } from "../protocol/index.ts";
import { git } from "../runtime/git.ts";

export interface DemoOptions {
  /** The directory demos are made in (`demosRoot()`); each demo gets a new directory inside it. */
  root: string;
  /** Who plays each step: the mock for all three in the free demo. */
  assignments: readonly RoleAssignment[];
}

export interface Demo {
  /** The demo's own directory, holding `project` and `remote.git`. */
  dir: string;
  /** The sample project: a git repository with one commit and `origin` set to `remote`. */
  project: string;
  /** A bare repository, the project's `origin`, which the approved branch is pushed to. */
  remote: string;
  /** The workflow file, in the project but not committed: the hidden test it holds stays out of every agent's copy. */
  workflow: string;
}

const README = `# AHP demo project

Made by \`ahp demo\`. Three coding agents build a small password-reset module here, one step after another:

1. **plan** reads the task and reports a summary and decisions (it may not write).
2. **implement** writes \`src/password-reset.mjs\`. It passes only when a test it never sees passes, in a fresh copy.
3. **review** checks the change; asking for changes sends implement back with the findings.

Then the run stops for your approval, showing the diff, and only then does AHP push the branch to \`origin\`
(a local stand-in for a real remote, \`../remote.git\`).
`;

/** Makes a new demo project, ready for `ahp run <workflow>`. */
export async function prepareDemo(options: DemoOptions): Promise<Demo> {
  await mkdir(options.root, { recursive: true });
  const dir = await mkdtemp(join(options.root, "demo-"));
  const project = join(dir, "project");
  const remote = join(dir, "remote.git");
  await git(dir, ["init", "--quiet", "--bare", remote]);
  await git(dir, ["init", "--quiet", project]);
  await git(project, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  // The demo's own identity and line endings, so it works whatever the user's git is configured with.
  for (const [key, value] of [["user.name", "AHP demo"], ["user.email", "demo@localhost"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) {
    await git(project, ["config", key, value]);
  }
  await git(project, ["remote", "add", DEFAULT_REMOTE, remote]);
  await writeFile(join(project, "README.md"), README);
  await git(project, ["add", "README.md"]);
  await git(project, ["commit", "--quiet", "--message", "The demo project"]);
  const workflow = join(project, DEFAULT_WORKFLOW_FILE);
  await writeFile(workflow, renderWorkflow(options.assignments, DEFAULT_BRANCH, "demo"));
  return { dir, project, remote, workflow };
}
