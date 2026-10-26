import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow } from "../../src/index.ts";
import type {
  MergePullRequestAction,
  OpenPullRequestAction,
  PullRequestProvider,
  PullRequestRecord,
  PushBranchAction,
  StepDefinition,
  WorkflowStepDefinition,
} from "../../src/index.ts";
import { gateStep } from "./approval.ts";
import { git, trackForRemoval } from "./repo.ts";

export const BRANCH = "ahp/greeting";

export const pushStep = (action: Partial<PushBranchAction> = {}): WorkflowStepDefinition => ({
  id: "push",
  action: { kind: "push_branch", branch: BRANCH, ...action },
});

export const openStep = (action: Partial<OpenPullRequestAction> = {}): WorkflowStepDefinition => ({
  id: "open",
  action: { kind: "open_pr", branch: BRANCH, base: "main", title: "Add a greeting", ...action },
});

export const mergeStep = (action: Partial<MergePullRequestAction> = {}): WorkflowStepDefinition => ({
  id: "merge",
  action: { kind: "merge_pr", branch: BRANCH, ...action },
});

/** Implement, the gate, then the external actions in `actions`. */
export const publishingWorkflow = (implement: StepDefinition, ...actions: WorkflowStepDefinition[]) =>
  defineWorkflow({ name: "publishing", steps: [implement, gateStep(), ...actions] });

/**
 * A bare repository in a fresh temporary directory, added to `repo` as remote `origin` with `main` pushed to it. It
 * keeps a reflog of every ref, so a test can count the updates a branch received.
 */
export function addBareRemote(repo: string, name = "origin"): string {
  const remote = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-remote-")));
  trackForRemoval(remote);
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(remote, "config", "core.logAllRefUpdates", "always");
  git(repo, "remote", "add", name, remote);
  git(repo, "push", "--quiet", name, "main");
  return remote;
}

/** The commit the bare remote's branch points at, or null when it has no such branch. */
export const remoteBranch = (remote: string, branch = BRANCH): string | null => {
  try {
    return git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return null;
  }
};

/** How many times the bare remote's branch was updated, as its reflog records it. */
export const updatesOf = (remote: string, branch = BRANCH): number => {
  try {
    return git(remote, "reflog", "show", `refs/heads/${branch}`).split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

/**
 * An in-memory pull-request host: what it holds survives across runs and resumptions for as long as the test keeps
 * it. Opening reads the branch's head from the real remote, so a pull request exists only for a pushed branch.
 */
export function fakePullRequests(options: { failOpen?: string; failFind?: string } = {}) {
  const pulls: (PullRequestRecord & { remote: string; branch: string; title: string; body: string; method: string | null })[] = [];
  const calls = { find: 0, open: 0, merge: 0 };
  const record = ({ number, url, state, headCommit, base }: PullRequestRecord): PullRequestRecord => ({ number, url, state, headCommit, base });
  const provider: PullRequestProvider = {
    async find({ remote, branch }) {
      calls.find += 1;
      if (options.failFind) throw new Error(options.failFind);
      return pulls.filter((pr) => pr.remote === remote && pr.branch === branch).reverse().map(record);
    },
    async open({ repo, remote, branch }, { base, title, body }) {
      calls.open += 1;
      if (options.failOpen) throw new Error(options.failOpen);
      const head = git(repo, "ls-remote", remote, `refs/heads/${branch}`).split("\t")[0];
      if (!head) throw new Error(`no branch ${branch} on ${remote}`);
      const number = pulls.length + 1;
      const pr = { number, url: `https://example.test/pull/${number}`, state: "open" as const, headCommit: head, base, remote, branch, title, body, method: null };
      pulls.push(pr);
      return record(pr);
    },
    async merge({ remote, branch }, { number, method, headCommit }) {
      calls.merge += 1;
      const pr = pulls.find((p) => p.number === number && p.remote === remote && p.branch === branch);
      if (!pr || pr.state !== "open") throw new Error(`no open pull request #${number}`);
      if (pr.headCommit !== headCommit) throw new Error(`head of #${number} is not ${headCommit}`);
      Object.assign(pr, { state: "merged", method });
      return record(pr);
    },
  };
  return { provider, pulls, calls };
}
