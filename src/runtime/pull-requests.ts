import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PULL_REQUEST_STATES, type MergeMethod, type PullRequestRecord, type PullRequestState } from "../protocol/index.ts";
import { git } from "./git.ts";

const execFileAsync = promisify(execFile);

/** Where a pull request lives: the repository at a git remote, and the branch it is from. */
export interface PullRequestTarget {
  /** The local repository the run works on. */
  repo: string;
  /** The configured git remote whose repository holds both the branch and the pull request. */
  remote: string;
  branch: string;
}

/**
 * The pull-request operations external actions need, behind one small interface: the real one runs the GitHub CLI
 * under the user's own login, and tests use an in-memory fake. AHP stores no credentials for either.
 */
export interface PullRequestProvider {
  /** The pull requests from the branch, in any state, newest first. */
  find(target: PullRequestTarget): Promise<PullRequestRecord[]>;
  open(target: PullRequestTarget, request: { base: string; title: string; body: string }): Promise<PullRequestRecord>;
  /** Merges the pull request, only while its head is `headCommit`, and returns it as it is afterwards. */
  merge(target: PullRequestTarget, request: { number: number; method: MergeMethod; headCommit: string }): Promise<PullRequestRecord>;
}

/** The GitHub CLI program and any arguments that come before its own; `gh` on PATH by default. */
export interface GithubCliOptions {
  file?: string;
  prefixArgs?: string[];
}

/** Never a prompt: with no terminal to answer it, `gh` would wait, or fail in a way that says nothing. */
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };

const PR_FIELDS = "number,url,state,headRefOid,baseRefName";

/**
 * Pull requests through the GitHub CLI (`gh`), under whatever login `gh auth login` gave it. The repository is the
 * one the remote's URL names, passed to every call, so `gh` never has to guess it from the checkout's remotes.
 */
export function githubCli(options: GithubCliOptions = {}): PullRequestProvider {
  const file = options.file ?? "gh";
  const prefixArgs = options.prefixArgs ?? [];
  const gh = async (target: PullRequestTarget, args: string[]): Promise<string> => {
    const repository = githubRepositoryOf(await git(target.repo, ["remote", "get-url", target.remote]));
    try {
      const { stdout } = await execFileAsync(file, [...prefixArgs, ...args, "--repo", repository], {
        cwd: target.repo,
        env: { ...process.env, ...GH_ENV },
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`gh ${args.slice(0, 2).join(" ")} failed${stderr ? `: ${stderr}` : `: ${(error as Error).message}`}`, { cause: error });
    }
  };
  const find = async (target: PullRequestTarget) =>
    parsePullRequests(await gh(target, ["pr", "list", "--head", target.branch, "--state", "all", "--json", PR_FIELDS, "--limit", "20"]));
  const numbered = async (target: PullRequestTarget, number: number) => {
    const found = (await find(target)).find((pr) => pr.number === number);
    if (!found) throw new Error(`gh did not list pull request #${number} from branch ${target.branch}`);
    return found;
  };
  return {
    find,
    async open(target, { base, title, body }) {
      const printed = await gh(target, ["pr", "create", "--head", target.branch, "--base", base, "--title", title, "--body", body]);
      // `gh pr create` prints the new pull request's URL, which ends in its number.
      const number = /\/pull\/(\d+)\s*$/.exec(printed.trim())?.[1];
      if (!number) throw new Error(`gh pr create printed no pull request URL: ${printed.trim().slice(0, 200)}`);
      return numbered(target, Number(number));
    },
    async merge(target, { number, method, headCommit }) {
      await gh(target, ["pr", "merge", String(number), `--${method}`, "--match-head-commit", headCommit]);
      return numbered(target, number);
    },
  };
}

/** What `gh pr list --json` printed, as records; throws on anything else. */
function parsePullRequests(printed: string): PullRequestRecord[] {
  const listed = JSON.parse(printed) as { number: number; url: string; state: string; headRefOid: string; baseRefName: string }[];
  return listed.map(({ number, url, state, headRefOid, baseRefName }) => {
    const lower = state.toLowerCase() as PullRequestState;
    if (!PULL_REQUEST_STATES.includes(lower)) throw new Error(`gh reported pull request #${number} in state ${state}`);
    return { number, url, state: lower, headCommit: headRefOid, base: baseRefName };
  });
}

/**
 * The `HOST/OWNER/REPO` a remote's URL names, for `gh --repo`: an `https://`, `ssh://` or `git@host:` URL. Throws for
 * one that names no hosted repository, such as a local path.
 */
export function githubRepositoryOf(url: string): string {
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`the remote's URL ${url} names no hosted repository the GitHub CLI can open pull requests in`);
  const [, host, owner, name] = match;
  return `${host}/${owner}/${name}`;
}
