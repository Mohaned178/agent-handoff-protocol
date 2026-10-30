import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorReport, ToolReport } from "../src/doctor/index.ts";
import type { ToolId } from "../src/doctor/tools.ts";
import { branchFor, castRoles, inferCommands, inferTask } from "../src/setup/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project on disk from a map of paths to contents; a path ending in "/" is an empty directory. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ahp-infer-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("/")) {
      mkdirSync(join(dir, path), { recursive: true });
      continue;
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const pkg = (scripts?: Record<string, string>) => JSON.stringify({ name: "x", ...(scripts ? { scripts } : {}) });
const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

type Found = [command: string, source: string] | null;

describe("inferCommands", () => {
  it.each<[string, Record<string, string>, Found, Found]>([
    ["package.json with a test script and package-lock.json", { "package.json": pkg({ test: "vitest run" }), "package-lock.json": "{}" }, ["npm test", "package.json"], ["npm ci", "package-lock.json"]],
    ["pnpm-lock.yaml", { "package.json": pkg({ test: "jest" }), "pnpm-lock.yaml": "" }, ["npm test", "package.json"], ["pnpm install --frozen-lockfile", "pnpm-lock.yaml"]],
    ["yarn.lock", { "package.json": pkg({ test: "jest" }), "yarn.lock": "" }, ["npm test", "package.json"], ["yarn install --frozen-lockfile", "yarn.lock"]],
    ["package.json alone", { "package.json": pkg({ test: "node --test" }) }, ["npm test", "package.json"], ["npm install", "package.json"]],
    ["npm's placeholder test script is no test", { "package.json": pkg({ test: NPM_PLACEHOLDER }), "package-lock.json": "{}" }, null, ["npm ci", "package-lock.json"]],
    ["package.json with no scripts", { "package.json": pkg() }, null, ["npm install", "package.json"]],
    ["package.json that does not parse", { "package.json": "{ not json" }, null, ["npm install", "package.json"]],
    ["pyproject.toml", { "pyproject.toml": "[project]\nname = \"x\"\n" }, ["pytest", "pyproject.toml"], null],
    ["pytest.ini", { "pytest.ini": "[pytest]\n" }, ["pytest", "pytest.ini"], null],
    ["a tests directory", { "tests/test_x.py": "def test_x(): pass\n" }, ["pytest", "tests/"], null],
    ["Cargo.toml", { "Cargo.toml": "[package]\nname = \"x\"\n" }, ["cargo test", "Cargo.toml"], null],
    ["go.mod", { "go.mod": "module x\n" }, ["go test ./...", "go.mod"], null],
    ["a Makefile with a test target", { Makefile: "build:\n\tcc x.c\n\ntest: build\n\t./run-tests\n" }, ["make test", "Makefile"], null],
    ["a Makefile listing test among several targets", { Makefile: "check test:\n\t./run-tests\n" }, ["make test", "Makefile"], null],
    ["a Makefile with no test target", { Makefile: ".PHONY: test\nTEST := 1\ntests:\n\techo\n" }, null, null],
    ["nothing to go on", { "README.md": "# x\n" }, null, null],
    ["package.json's test script wins over the rest", { "package.json": pkg({ test: "jest" }), "pyproject.toml": "", "Cargo.toml": "", Makefile: "test:\n" }, ["npm test", "package.json"], ["npm install", "package.json"]],
    ["pytest before cargo, go and make", { "pyproject.toml": "", "Cargo.toml": "", "go.mod": "", Makefile: "test:\n" }, ["pytest", "pyproject.toml"], null],
    ["package-lock.json without package.json installs nothing", { "package-lock.json": "{}", "go.mod": "module x\n" }, ["go test ./...", "go.mod"], null],
  ])("%s", (_name, files, check, install) => {
    const found = inferCommands(project(files));

    expect(found.check && [found.check.command, found.check.source]).toEqual(check);
    expect(found.install && [found.install.command, found.install.source]).toEqual(install);
  });

  it("reads only the repository's own files: a package.json linked from outside it is not read", (context) => {
    const outside = project({ "package.json": pkg({ test: "outside" }) });
    const dir = project({});
    try {
      symlinkSync(join(outside, "package.json"), join(dir, "package.json"), "file");
    } catch {
      context.skip(); // creating a symbolic link needs a privilege Windows does not give everyone
    }

    expect(inferCommands(dir)).toEqual({ check: null, install: null });
  });
});

const tool = (id: ToolId, usable = true): ToolReport => ({ id, usable }) as ToolReport;
const report = (...usable: ToolId[]): DoctorReport =>
  ({ tools: (["claude-code", "codex", "opencode"] as const).map((id) => tool(id, usable.includes(id))) }) as unknown as DoctorReport;
const cast = (assignments: ReturnType<typeof castRoles>) => assignments.map(({ role, adapter, model }) => `${role}=${adapter}${model ? `/${model}` : ""}`);

describe("castRoles", () => {
  it("casts as ahp init does when the person has no defaults", () => {
    expect(cast(castRoles(report("claude-code", "codex", "opencode")))).toEqual(["plan=claude-code", "implement=codex", "review=opencode"]);
    expect(cast(castRoles(report()))).toEqual(["plan=mock", "implement=mock", "review=mock"]);
  });

  it("puts the person's defaults on top, with their model and effort, and says they are theirs", () => {
    const assignments = castRoles(report("claude-code", "codex", "opencode"), { review: { tool: "claude-code", model: "opus", effort: "high" } });

    expect(cast(assignments)).toEqual(["plan=claude-code", "implement=codex", "review=claude-code/opus"]);
    expect(assignments[2]).toMatchObject({ tool: "claude-code", effort: "high", reason: "your default" });
  });

  it("keeps its own casting for a role whose default tool is not usable here, and says why", () => {
    const [, , review] = castRoles(report("codex"), { review: { tool: "claude-code", model: "opus" } });

    expect(review).toMatchObject({ adapter: "codex", tool: "codex" });
    expect(review!.model).toBeUndefined();
    expect(review!.reason).toMatch(/your default, Claude Code, is not usable here/);
  });
});

describe("branchFor", () => {
  it("names the branch after the task's first words", () => {
    expect(branchFor("Fix the bug where the cart total ignores quantity", [])).toBe("ahp/fix-the-bug-where-the");
  });

  it("adds a number when the branch exists", () => {
    expect(branchFor("fix the cart", ["main", "ahp/fix-the-cart"])).toBe("ahp/fix-the-cart-2");
    expect(branchFor("fix the cart", ["ahp/fix-the-cart", "ahp/fix-the-cart-2"])).toBe("ahp/fix-the-cart-3");
  });

  it("names a task with no letters or digits it can use", () => {
    expect(branchFor("¿¡!", [])).toBe("ahp/task");
  });
});

describe("inferTask", () => {
  it("answers every question ahp setup would ask about the project, each with its source", () => {
    const dir = project({ "package.json": pkg({ test: "vitest run" }), "package-lock.json": "{}" });

    const inferred = inferTask({ dir, task: "fix the cart total", report: report("codex", "claude-code"), branches: ["ahp/fix-the-cart-total"] });

    expect(inferred).toMatchObject({
      task: "fix the cart total",
      check: { command: "npm test", source: "package.json" },
      install: { command: "npm ci", source: "package-lock.json" },
      branch: "ahp/fix-the-cart-total-2",
    });
    expect(cast(inferred.assignments)).toEqual(["plan=claude-code", "implement=codex", "review=claude-code"]);
  });
});
