import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { githubCli } from "../src/index.ts";
import { createTempRepo, git, removeTempRepos, trackForRemoval } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const fakeGh = fileURLToPath(new URL("./helpers/fake-gh.ts", import.meta.url));
const HEAD = "a".repeat(40);

/** A repository whose `origin` has `url`, and `githubCli()` running the fake `gh` over a state file of its own. */
function setup(url = "https://github.com/acme/widgets.git", state: Record<string, unknown> = {}) {
  const repo = createTempRepo({ "README.md": "widgets\n" });
  git(repo, "remote", "add", "origin", url);
  const dir = mkdtempSync(join(tmpdir(), "ahp-gh-"));
  trackForRemoval(dir);
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ pulls: [], calls: [], head: HEAD, ...state }));
  const gh = githubCli({ file: process.execPath, prefixArgs: [fakeGh, stateFile] });
  const read = () => JSON.parse(readFileSync(stateFile, "utf8")) as { calls: { args: string[]; promptDisabled: string | null }[] };
  return { gh, target: { repo, remote: "origin", branch: "ahp/greeting" }, read };
}

describe("pull requests through the GitHub CLI", () => {
  it("opens, finds and merges, naming the remote's repository and never letting gh prompt", async () => {
    const { gh, target, read } = setup();

    expect(await gh.find(target)).toEqual([]);
    const opened = await gh.open(target, { base: "main", title: "Add a greeting", body: "From AHP." });
    const merged = await gh.merge(target, { number: opened.number, method: "squash", headCommit: HEAD });

    const pr = { number: 1, url: "https://github.com/acme/widgets/pull/1", headCommit: HEAD, base: "main" };
    expect(opened).toEqual({ ...pr, state: "open" });
    expect(merged).toEqual({ ...pr, state: "merged" });
    expect(await gh.find(target)).toEqual([{ ...pr, state: "merged" }]);
    const { calls } = read();
    expect(calls.map((call) => call.args)).toContainEqual([
      "pr", "create", "--head", "ahp/greeting", "--base", "main", "--title", "Add a greeting", "--body", "From AHP.", "--repo", "github.com/acme/widgets",
    ]);
    expect(calls.map((call) => call.args)).toContainEqual(["pr", "merge", "1", "--squash", "--match-head-commit", HEAD, "--repo", "github.com/acme/widgets"]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "pr", "list", "--head", "ahp/greeting", "--state", "all", "--json", "number,url,state,headRefOid,baseRefName", "--limit", "20", "--repo", "github.com/acme/widgets",
    ]);
    expect(calls.every((call) => call.promptDisabled === "1")).toBe(true);
  });

  it.each([
    ["git@github.com:acme/widgets.git", "github.com/acme/widgets"],
    ["ssh://git@github.example.com:2222/acme/widgets", "github.example.com/acme/widgets"],
    ["https://token@github.com/acme/widgets/", "github.com/acme/widgets"],
  ])("reads the repository of remote URL %s as %s", async (url, repository) => {
    const { gh, target, read } = setup(url);

    await gh.find(target);

    expect(read().calls[0]!.args.slice(-2)).toEqual(["--repo", repository]);
  });

  it("refuses a remote whose URL names no hosted repository, without running gh", async () => {
    const { gh, target, read } = setup(join(tmpdir(), "somewhere", "widgets.git"));

    await expect(gh.find(target)).rejects.toThrow(/names no hosted repository the GitHub CLI can open pull requests in/);
    expect(read().calls).toEqual([]);
  });

  it("reports what gh said when it fails", async () => {
    const { gh, target } = setup(undefined, { fail: "To get started with GitHub CLI, please run:  gh auth login" });

    await expect(gh.open(target, { base: "main", title: "t", body: "b" })).rejects.toThrow(
      "gh pr create failed: To get started with GitHub CLI, please run:  gh auth login",
    );
  });
});
