import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRepository, NO_GIT_IDENTITY, prepareRepository, RepositoryError } from "../src/setup/repository.ts";
import { markFirstOpenDone, markRealAgentsNoticed, readSettings, saveStepDefault } from "../src/setup/settings.ts";
import { createTempRepo, git, removeTempRepos, trackForRemoval } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const folder = (files: Record<string, string> = {}) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-folder-")));
  trackForRemoval(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
};

/** git's view of who the person is, replaced for one test (the test process's own global config is the maintainer's). */
function withIdentity(identity: Record<string, string | undefined>, test: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  return async () => {
    Object.assign(process.env, identity);
    for (const [key, value] of Object.entries(identity)) if (value === undefined) delete process.env[key];
    try {
      await test();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

const KNOWN = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@localhost" };
const emptyConfig = () => {
  const file = join(folder(), "empty-gitconfig");
  writeFileSync(file, "");
  return file;
};
const UNKNOWN = () => ({ GIT_CONFIG_GLOBAL: emptyConfig(), GIT_CONFIG_SYSTEM: emptyConfig(), GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined, EMAIL: undefined });

describe("inspectRepository", () => {
  it("is ready in a repository with a commit, and names the top of the working tree from a folder inside it", async () => {
    const repo = createTempRepo({ "a.txt": "a\n" });
    mkdirSync(join(repo, "sub"));
    expect(await inspectRepository(repo)).toEqual({ kind: "ready", repo: realpathSync.native(repo) });
    expect(await inspectRepository(join(repo, "sub"))).toEqual({ kind: "ready", repo: realpathSync.native(repo) });
  });

  it(
    "is a folder that is not a repository, then a repository with no commit, when git knows who the person is",
    withIdentity(KNOWN, async () => {
      const dir = folder({ "a.txt": "a\n" });
      expect(await inspectRepository(dir)).toEqual({ kind: "not_repository", dir });
      git(dir, "init", "--quiet");
      expect(await inspectRepository(dir)).toEqual({ kind: "no_commit", repo: realpathSync.native(dir) });
    }),
  );

  it(
    "says there is no identity first, and only when a commit has to be made",
    withIdentity(UNKNOWN(), async () => {
      const dir = folder();
      expect(await inspectRepository(dir)).toEqual({ kind: "no_identity", dir, then: "not_repository" });
      git(dir, "init", "--quiet");
      expect(await inspectRepository(dir)).toEqual({ kind: "no_identity", dir: realpathSync.native(dir), then: "no_commit" });
      expect(NO_GIT_IDENTITY).toContain('git config --global user.name "Your Name"');
      expect(NO_GIT_IDENTITY).toContain("git config --global user.email you@example.com");
    }),
  );

  it("refuses the home folder, and counts a repository that is the home folder as no repository", async () => {
    const home = folder();
    expect(await inspectRepository(home, home)).toEqual({ kind: "home_folder", dir: home });
    const kept = createTempRepo({ "a.txt": "a\n" });
    mkdirSync(join(kept, "project"));
    // The project folder inside a home folder kept under git: the repository around it is not the project meant.
    const state = await inspectRepository(join(kept, "project"), kept);
    expect(state.kind === "not_repository" || state.kind === "no_identity").toBe(true);
    expect(state).not.toMatchObject({ kind: "ready" });
  });
});

describe("prepareRepository", () => {
  it(
    "makes a folder a repository with a first commit of what is in it",
    withIdentity(KNOWN, async () => {
      const dir = folder({ "a.txt": "a\n" });
      const repo = await prepareRepository({ kind: "not_repository", dir });
      expect(repo).toBe(realpathSync.native(dir));
      expect(git(dir, "log", "--format=%s")).toBe("First commit");
      expect(git(dir, "show", "HEAD:a.txt")).toBe("a");
      expect(await inspectRepository(dir)).toMatchObject({ kind: "ready" });
    }),
  );

  it(
    "commits what is in a repository that has no commit yet",
    withIdentity(KNOWN, async () => {
      const dir = folder({ "b.txt": "b\n" });
      git(dir, "init", "--quiet");
      await prepareRepository({ kind: "no_commit", repo: dir });
      expect(git(dir, "show", "HEAD:b.txt")).toBe("b");
    }),
  );

  it("refuses a state with nothing to make ready", async () => {
    await expect(prepareRepository({ kind: "ready", repo: "/x" })).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe("the settings file keeps its flags across every save", () => {
  it("firstOpenDone survives a saved default and the real-agents notice, and is read as missing in an older file", async () => {
    const path = join(folder(), "settings.json");
    expect((await readSettings(path)).settings.firstOpenDone).toBeUndefined();

    await markFirstOpenDone(path, { implement: { tool: "codex", model: "gpt-5.6" } });
    let { settings } = await readSettings(path);
    expect(settings.firstOpenDone).toBe(true);
    expect(settings.steps).toEqual({ implement: { tool: "codex", model: "gpt-5.6" } });

    await saveStepDefault(path, "review", { tool: "claude-code", model: "sonnet" });
    await markRealAgentsNoticed(path);
    ({ settings } = await readSettings(path));
    expect(settings.firstOpenDone).toBe(true);
    expect(settings.realAgentsNoticed).toBe(true);
    expect(Object.keys(settings.steps).sort()).toEqual(["implement", "review"]);

    const older = join(folder(), "older.json");
    writeFileSync(older, JSON.stringify({ steps: { plan: { tool: "claude-code" } }, realAgentsNoticed: true }));
    expect((await readSettings(older)).settings).toEqual({ steps: { plan: { tool: "claude-code" } }, realAgentsNoticed: true });
  });

  it("marking first open done keeps the steps already saved, and saves none when none was changed", async () => {
    const path = join(folder(), "settings.json");
    await saveStepDefault(path, "plan", { tool: "claude-code", effort: "high" });
    await markFirstOpenDone(path);
    const { settings } = await readSettings(path);
    expect(settings).toEqual({ steps: { plan: { tool: "claude-code", effort: "high" } }, firstOpenDone: true });
  });
});
