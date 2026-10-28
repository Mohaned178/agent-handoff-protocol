import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changesBetween, fileListOf, hashOfFiles, loadTask, parseTask, TaskInvalidError } from "../src/evaluation/index.ts";
import { greetingFiles, greetingSpec, greetingTaskDir, writeTree } from "./helpers/evaluation.ts";
import { removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const bytes = (files: Record<string, string>) => new Map(Object.entries(files).map(([path, content]) => [path, Buffer.from(content)]));

describe("the freeze hash", () => {
  it("is the SHA-256 of the sorted (path, content hash) pairs: a known answer worked out independently of the code", () => {
    // sha256("alpha\n") and sha256("beta\n"), and the sha256 of `[["a.txt",<alpha>],["dir/b.txt",<beta>]]`, taken with plain crypto.
    const list = fileListOf(bytes({ "dir/b.txt": "beta\n", "a.txt": "alpha\n" }));

    expect(list).toEqual([
      { path: "a.txt", sha256: "b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060" },
      { path: "dir/b.txt", sha256: "f2c82decdd7181cf98945929a62598db7e6b477e11f6e0eb0ae97020eff151ad" },
    ]);
    expect(hashOfFiles(list)).toBe("8724952a96357dba023091a58876d83a1eaebbdb14635b06de7c208f097ed50e");
  });

  it("does not depend on the order the files were read in, and changes with any file added, removed, renamed or changed by a byte", () => {
    const base = { "a.txt": "alpha\n", "dir/b.txt": "beta\n" };
    const hashOf = (files: Record<string, string>) => hashOfFiles(fileListOf(bytes(files)));

    expect(hashOf({ "dir/b.txt": "beta\n", "a.txt": "alpha\n" })).toBe(hashOf(base));
    const changed: Record<string, string>[] = [
      { ...base, "c.txt": "" },
      { "a.txt": "alpha\n" },
      { "a.txt": "alpha\n", "dir/c.txt": "beta\n" },
      { "a.txt": "alpha\n", "dir/b.txt": "beta" },
    ];
    for (const files of changed) expect(hashOf(files)).not.toBe(hashOf(base));
  });

  it("says which paths were added, deleted or modified between two lists", () => {
    const frozen = fileListOf(bytes({ "a.txt": "1", "b.txt": "2", "c.txt": "3" }));
    const found = fileListOf(bytes({ "a.txt": "1", "b.txt": "two", "d.txt": "4" }));

    expect(changesBetween(frozen, found)).toEqual([
      { path: "b.txt", change: "modified" },
      { path: "c.txt", change: "deleted" },
      { path: "d.txt", change: "added" },
    ]);
  });
});

describe("loading a task", () => {
  it("reads task.json, the fixture under repo/ and the hidden tests under hidden/, and hashes the whole directory and the hidden tests", async () => {
    const dir = greetingTaskDir();

    const loaded = await loadTask(dir);

    expect(loaded.task).toMatchObject({
      id: "greeting",
      prompt: "Create greeting.txt containing the word hello.",
      verification: { command: "node check-greeting.mjs", protectedPaths: [] },
      network: { stance: "deny" },
      seededDefects: [],
    });
    expect([...loaded.task.fixture.keys()]).toEqual(["README.md"]);
    expect(loaded.task.hiddenTests.map((test) => test.path)).toEqual(["check-greeting.mjs"]);
    expect(loaded.task.constraints.map((constraint) => constraint.id)).toEqual(["no-goodbye"]);
    expect(loaded.files.map((file) => file.path)).toEqual(["hidden/check-greeting.mjs", "repo/README.md", "task.json"]);
    // The same bytes on disk, the same hashes: loading twice agrees, and a change to a hidden test changes both hashes.
    const again = await loadTask(dir);
    expect(again.hash).toBe(loaded.hash);
    expect(again.hiddenTestsHash).toBe(loaded.hiddenTestsHash);
    writeFileSync(join(dir, "hidden", "check-greeting.mjs"), "process.exit(0);\n");
    const edited = await loadTask(dir);
    expect(edited.hash).not.toBe(loaded.hash);
    expect(edited.hiddenTestsHash).not.toBe(loaded.hiddenTestsHash);
  });

  it("freezes a change to anything else in the directory too, though the hidden tests' hash stays", async () => {
    const dir = greetingTaskDir({}, { "notes.md": "first draft\n" });
    const before = await loadTask(dir);

    writeFileSync(join(dir, "notes.md"), "second draft\n");
    const after = await loadTask(dir);

    expect(after.hash).not.toBe(before.hash);
    expect(after.hiddenTestsHash).toBe(before.hiddenTestsHash);
  });

  it.each([
    ["no task.json", () => { const files = greetingFiles(); delete (files as Record<string, string>)["task.json"]; return files; }, /no `task.json`/],
    ["no fixture", () => { const files = greetingFiles(); delete (files as Record<string, string>)["repo/README.md"]; return files; }, /`repo\/` holds no files/],
    ["no hidden tests", () => { const files = greetingFiles(); delete (files as Record<string, string>)["hidden/check-greeting.mjs"]; return files; }, /`hidden\/` holds no files/],
    ["an unknown property", () => greetingFiles({ difficulty: "hard" }), /unknown property `difficulty`/],
    ["no prompt", () => greetingFiles({ prompt: " " }), /non-empty `prompt`/],
    ["no verification command", () => greetingFiles({ verification: {} }), /non-empty `verification.command`/],
    ["a protected path with a .. segment", () => greetingFiles({ verification: { command: "node x", protectedPaths: ["../outside"] } }), /protectedPaths/],
    ["a constraint check that is a judgement", () => greetingFiles({ constraints: [{ id: "tidy", statement: "Keep it tidy.", check: { kind: "llm_judge", rubric: "is it tidy" } }] }), /never judged/],
    ["a forbidden pattern that does not compile", () => greetingFiles({ constraints: [{ id: "bad", statement: "x", check: { kind: "forbidden_pattern", pattern: "(" } }] }), /does not compile/],
    ["a forbidden pattern the fixture already matches", () => greetingFiles({ constraints: [{ id: "readme", statement: "x", check: { kind: "forbidden_pattern", pattern: "greeting" } }] }), /fixture already matches/],
    ["two constraints with one id", () => { const c = (greetingSpec().constraints as unknown[])[0]; return greetingFiles({ constraints: [c, c] }); }, /listed twice/],
    ["a seeded defect in a file the fixture does not have", () => greetingFiles({ seededDefects: [{ id: "d1", description: "off by one", path: "src/nothing.js" }] }), /must name a file of the fixture/],
    ["a network stance that is not one", () => greetingFiles({ network: { stance: "open" } }), /\`network\` must be an object with a \`stance\`/],
  ])("rejects a task with %s, naming the problem", async (_name, files, message) => {
    const dir = writeTree(files());

    await expect(loadTask(dir)).rejects.toSatisfy((error: unknown) => error instanceof TaskInvalidError && error.problems.some((problem) => message.test(problem)));
  });

  it("accepts a seeded defect that names a fixture file, and a constraint that is a command", async () => {
    const files = greetingFiles(
      {
        seededDefects: [{ id: "off-by-one", description: "the page size is one too many", path: "src/page.js" }],
        constraints: [{ id: "still-green", statement: "Existing behaviour keeps working.", check: { kind: "required_invariant", command: "node invariant.mjs" } }],
      },
      { "repo/src/page.js": "export const size = 11;\n" },
    );

    const loaded = await loadTask(writeTree(files));

    expect(loaded.task.seededDefects).toEqual([{ id: "off-by-one", description: "the page size is one too many", path: "src/page.js" }]);
    expect(loaded.task.constraints[0]?.check).toEqual({ kind: "required_invariant", command: "node invariant.mjs" });
  });

  it("refuses a directory that holds a git repository or a symbolic link, which would not freeze as plain files", async () => {
    const withGit = writeTree(greetingFiles({}, { "repo/.git/HEAD": "ref: refs/heads/main\n" }));
    await expect(loadTask(withGit)).rejects.toThrow(/a task holds plain files, not a git repository/);

    const withLink = writeTree(greetingFiles());
    mkdirSync(join(withLink, "elsewhere"));
    try {
      symlinkSync(join(withLink, "elsewhere"), join(withLink, "link"), "junction");
    } catch {
      return; // a platform or account that may not make links has nothing to test here
    }
    await expect(loadTask(withLink)).rejects.toThrow(/is a symbolic link/);
  });

  it("hashes what parseTask is given, so a trial can use exactly the bytes that were hashed", () => {
    const files = bytes(greetingFiles());

    expect(parseTask("in-memory", files).hash).toBe(hashOfFiles(fileListOf(files)));
  });
});
