import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assignRoles, renderWorkflow, validateWorkflow, type ToolId } from "../src/index.ts";
import { ahp } from "./helpers/cli.ts";
import { addBareRemote, remoteBranch } from "./helpers/external.ts";
import { FAKE_SECRETS, fakeToolsDir, installFakeTool, pathWithFakes, pathWithoutTools } from "./helpers/fake-tools.ts";
import { createTempRepo, git, removeTempRepos } from "./helpers/repo.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

afterEach(removeTempRepos);

const cast = (usable: ToolId[]) => assignRoles(usable).map(({ role, adapter }) => `${role}=${adapter}`);

describe("assignRoles", () => {
  it.each<[string, ToolId[], string[]]>([
    ["every tool usable: the reference casting", ["claude-code", "codex", "opencode", "gemini-cli"], ["plan=claude-code", "implement=codex", "review=opencode"]],
    ["no tool usable: the mock plays every role", [], ["plan=mock", "implement=mock", "review=mock"]],
    ["one tool: it plays every role", ["codex"], ["plan=codex", "implement=codex", "review=codex"]],
    ["the preferred tool where usable, another for the rest", ["opencode", "codex"], ["plan=codex", "implement=codex", "review=opencode"]],
    ["Gemini CLI only when nothing else is usable", ["gemini-cli", "opencode"], ["plan=opencode", "implement=opencode", "review=opencode"]],
    ["Gemini CLI alone", ["gemini-cli"], ["plan=gemini-cli", "implement=gemini-cli", "review=gemini-cli"]],
  ])("%s", (_name, usable, expected) => {
    expect(cast(usable)).toEqual(expected);
  });

  it("says why each role got its adapter", () => {
    expect(assignRoles([]).every((assignment) => assignment.tool === null && /mock adapter stands in/.test(assignment.reason))).toBe(true);
    expect(assignRoles(["codex"])[0]!.reason).toMatch(/Claude Code is not usable here; Codex CLI is/);
  });
});

describe("the generated workflow", () => {
  it("passes static validation for any casting that names registered adapters, and marks the mock in its header", () => {
    const text = renderWorkflow(assignRoles([]));

    expect(text).toMatch(/plan\s+mock\s+\(scripted mock: not a real coding agent, and its output is no evidence\)/);
    expect(text).toContain("export default {");
  });

  it("refuses to be written for an adapter the build does not have, rather than produce a workflow `ahp run` would reject", () => {
    expect(() => renderWorkflow(assignRoles(["codex"]))).toThrow(/the generated workflow is invalid[^]*unknown adapter "codex"/);
  });
});

describe("ahp init", () => {
  it("writes a workflow that validates, using the mock adapter for roles no installed tool can play, and says so", async () => {
    const repo = createTempRepo({ "README.md": "x\n" });

    const init = ahp(["init"], repo, await pathWithoutTools());

    expect(init.code).toBe(0);
    expect(init.stdout).toContain("ahp.workflow.mjs");
    expect(init.stdout).toMatch(/implement: mock \[mock\]/);
    const workflow = ((await import(pathToFileURL(join(repo, "ahp.workflow.mjs")).href)) as { default: unknown }).default;
    expect(validateWorkflow(workflow)).toEqual([]);
    expect((workflow as { steps: { id: string }[] }).steps.map((step) => step.id)).toEqual(["plan", "implement", "review", "approve", "publish"]);
  });

  it("writes to the file it is given, and never replaces one that exists", () => {
    const repo = createTempRepo({ "mine.mjs": "keep me\n" });

    const refused = ahp(["init", "mine.mjs"], repo);
    const named = ahp(["init", "other.mjs"], repo);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("already exists");
    expect(readFileSync(join(repo, "mine.mjs"), "utf8")).toBe("keep me\n");
    expect(named.code).toBe(0);
    expect(existsSync(join(repo, "other.mjs"))).toBe(true);
  });

  it("generates a workflow that runs end to end with the mock adapter: plan, implement, review sends it back, gate, push", async () => {
    const env = await pathWithoutTools();
    const repo = createTempRepo({ "README.md": "x\n" });
    const remote = addBareRemote(repo);
    expect(ahp(["init"], repo, env).code).toBe(0);
    git(repo, "add", "ahp.workflow.mjs");
    git(repo, "commit", "--quiet", "--message", "add the workflow");

    const run = ahp(["run", "ahp.workflow.mjs"], repo, env);

    // Stopped at the approval gate, nothing published yet.
    expect(run.code, run.stdout + run.stderr).toBe(4);
    expect(run.stdout).toMatch(/step_sent_back|sent back/i);
    expect(run.stdout).toContain("[mock]");
    expect(remoteBranch(remote, "ahp/password-reset")).toBeNull();
    const runId = /(run_[a-z0-9]+)/.exec(run.stdout)![1]!;

    const approve = ahp(["approve", runId, "approve", "--repo", repo], repo, env);

    expect(approve.code, approve.stdout + approve.stderr).toBe(0);
    const pushed = remoteBranch(remote, "ahp/password-reset");
    expect(pushed).not.toBeNull();
    // The pushed commit holds the module the mock implemented, as the hidden test required.
    expect(git(remote, "show", `${pushed}:src/password-reset.mjs`)).toContain("export function resetPassword");
    expect(git(remote, "show", `${pushed}:src/password-reset.mjs`)).toContain("A token works once");
  });
});

describe("ahp doctor", () => {
  const cli = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));

  it("prints the report as JSON, exits 0 with no tool installed, and carries no credential", async () => {
    const { dir, log } = fakeToolsDir();
    installFakeTool(dir, log, "claude", `if (argv[0] === "--version") console.log("2.0.1"); else console.log(JSON.stringify({ loggedIn: true, email: ${JSON.stringify(FAKE_SECRETS[0])}, token: ${JSON.stringify(FAKE_SECRETS[1])} }));`);

    const result = spawnSync(process.execPath, [cli, "doctor", "--json"], { encoding: "utf8", env: { ...process.env, ...(await pathWithFakes(dir)) }, windowsHide: true });

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as { ok: boolean; tools: { id: string; installed: boolean; login: { state: string } }[] };
    expect(report.ok).toBe(true);
    expect(report.tools.map((tool) => [tool.id, tool.installed])).toEqual([
      ["claude-code", true],
      ["codex", false],
      ["opencode", false],
      ["gemini-cli", false],
    ]);
    expect(report.tools[0]!.login.state).toBe("logged_in");
    for (const secret of FAKE_SECRETS) expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it("takes no argument", () => {
    const repo = createTempRepo({ "README.md": "x\n" });

    expect(ahp(["doctor", "extra"], repo).code).toBe(2);
  });
});
