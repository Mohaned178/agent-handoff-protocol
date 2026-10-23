import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const cliEntry = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));
const binEntry = fileURLToPath(new URL("../bin/ahp.mjs", import.meta.url));

function ahp(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [cliEntry, ...args], { cwd, encoding: "utf8", windowsHide: true });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function workflowFile(content: string): string {
  return `export default {
  name: "greeting",
  steps: [
    {
      id: "implement",
      agent: { adapter: "mock", options: { attempts: [{ edits: [{ path: "greeting.txt", content: ${JSON.stringify(content)} }] }] } },
      verification: { command: "node verify.mjs" },
    },
  ],
};
`;
}

describe("ahp run and ahp inspect", () => {
  it("runs a workflow, streams progress labelled as mock, and inspects the derived state", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflowFile("hello\n") });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/step implement: attempt \S+ \[mock\] running/);
    expect(run.stdout).toMatch(/step implement: verifying \[mock\]: node verify\.mjs/);
    expect(run.stdout).toMatch(/step implement: verification pass/);
    expect(run.stdout).toMatch(/step implement: succeeded \[mock\]/);
    expect(run.stdout).toMatch(/run run_[a-z0-9]+: succeeded \[mock\]/);
    expect(run.stdout).toContain("mock adapter");
    const runId = /run (run_[a-z0-9]+): succeeded/.exec(run.stdout)?.[1];
    expect(runId).toBeDefined();

    const inspect = ahp(["inspect", runId!, "--repo", repo], join(repo, ".."));

    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain(`run ${runId}: succeeded [mock]`);
    expect(inspect.stdout).toMatch(/step implement: succeeded \[mock\]/);
    expect(inspect.stdout).toMatch(/attempt \S+ \[mock\]: exited ok \(exit code 0\)/);
    expect(inspect.stdout).toMatch(/verification: pass/);
    expect(inspect.stdout).toContain("greeting ok");
    expect(inspect.stdout).toContain("not evidence");
  });

  it("prints the derived state as JSON with --json", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflowFile("hello\n") });
    const runId = /run (run_[a-z0-9]+): succeeded/.exec(ahp(["run", "workflow.mjs"], repo).stdout)?.[1];

    const inspect = ahp(["inspect", runId!, "--json"], repo);

    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout)).toMatchObject({ runId, state: "succeeded", mock: true });
  });

  it("exits 1 when the run fails verification", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflowFile("goodbye\n") });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/step implement: verification fail/);
    expect(run.stdout).toMatch(/step implement: failed \(verification_failed\) \[mock\]/);
    expect(run.stdout).toMatch(/run run_[a-z0-9]+: failed \[mock\]/);
  });

  it("reports an invalid workflow without starting a run", () => {
    const repo = createTempRepo({ "workflow.mjs": "export default { name: 'x', steps: [] };\n" });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("workflow needs at least one step");
  });

  it("reports an unknown run", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const inspect = ahp(["inspect", "run_doesnotexist"], repo);

    expect(inspect.code).toBe(1);
    expect(inspect.stderr).toContain("no run run_doesnotexist");
  });

  it("prints usage and exits 2 for an unknown command", () => {
    const result = ahp(["launch"], process.cwd());

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: ahp");
  });
});

describe("ahp on an unsupported Node version", () => {
  it("refuses to start below Node 24 with a clear message", () => {
    const repo = createTempRepo({
      "old-node.mjs": `Object.defineProperty(process.versions, "node", { value: "22.11.0" });\n`,
    });
    const preload = join(repo, "old-node.mjs");

    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, binEntry, "--help"], {
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ahp requires Node.js 24 or newer");
    expect(result.stderr).toContain("22.11.0");
    expect(result.stdout).toBe("");
  });
});
