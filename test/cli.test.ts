import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunInspection } from "../src/index.ts";
import { ahp } from "./helpers/cli.ts";
import { appendLedgerEvent } from "./helpers/ledger.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING, VERIFY_OK } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const binEntry = fileURLToPath(new URL("../bin/ahp.mjs", import.meta.url));

function workflowFile(content: string): string {
  return `export default {
  name: "greeting",
  steps: [
    {
      id: "implement",
      agent: { adapter: "mock", options: { attempts: [{ edits: [{ path: "greeting.txt", content: ${JSON.stringify(content)} }] }] } },
      verification: { command: "node verify.mjs" },
      retry: { budget: 0 },
    },
  ],
};
`;
}

describe("ahp inspect with protected paths and hidden tests", () => {
  it("shows what the attempt changed, the protected-path violation and that the command was not run", () => {
    const workflow = `export default {
  name: "scoped",
  steps: [
    {
      id: "implement",
      agent: { adapter: "mock", options: { attempts: [{ edits: [{ path: "runner.config.mjs", content: "tampered\\n" }] }] } },
      verification: {
        command: "node verify.mjs",
        protectedPaths: ["runner.config.mjs"],
        hiddenTests: [{ path: "hidden/check.mjs", content: "process.exit(0);\\n" }],
      },
      retry: { budget: 0 },
    },
  ],
};
`;
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK, "runner.config.mjs": "ok\n", "workflow.mjs": workflow });

    const run = ahp(["run", "workflow.mjs"], repo);
    const runId = /run (run_[a-z0-9]+): failed/.exec(run.stdout)?.[1];
    expect(runId).toBeDefined();
    const inspect = ahp(["inspect", runId!, "--repo", repo], repo);

    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain("verification: fail");
    expect(inspect.stdout).toContain("evidence: diff scope (1 changed)");
    expect(inspect.stdout).toContain("| modified runner.config.mjs");
    expect(inspect.stdout).toContain("evidence: protected paths (runner.config.mjs, hidden/check.mjs): changed, the verification command was not run");
  });
});

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
    expect(JSON.parse(inspect.stdout)).toMatchObject({ state: { runId, state: "succeeded", mock: true } });
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

  it("says how to get started, and exits 0, when given no command", () => {
    const result = ahp([], process.cwd());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Try it, with nothing to set up:   ahp demo");
    expect(result.stdout).toContain('Do a task in your project:        cd your-project, then ahp "fix the bug where the cart total ignores quantity"');
    expect(result.stdout).toContain("Write a workflow to keep:         cd your-project, then ahp");
    expect(result.stdout).toContain("More commands: ahp --help (every command and option: ahp --help --all)");
  });

  it("prints usage and exits 2 for an unknown command", () => {
    const result = ahp(["launch"], process.cwd());

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: ahp");
  });

  it("starts --help with the commands a new user needs, and keeps the rest for --help --all", () => {
    const short = ahp(["--help"], process.cwd());
    const all = ahp(["--help", "--all"], process.cwd());

    expect(short.code).toBe(0);
    for (const command of ['"<task>"', "demo", "doctor", "runs", "inspect [run-id]", "approve <run-id> <step-id>", "reject <run-id> <step-id>"]) {
      expect(short.stdout).toContain(`  ${command}`);
    }
    expect(short.stdout).not.toContain("eval <suite-file>");
    expect(short.stdout).not.toContain("recover <run-id>");
    expect(short.stdout).toContain("ahp --help --all");
    expect(short.stdout.split("\n").length).toBeLessThan(all.stdout.split("\n").length / 2);

    expect(all.code).toBe(0);
    for (const command of ["setup", "run <workflow-file>", "eval <suite-file>", "recover <run-id>", "settings", "Exit codes:"]) {
      expect(all.stdout).toContain(command);
    }
  });
});

const PLAN = "# Plan\n- add the endpoint\n";

/** A plan -> implement workflow file: plan hands on a summary and PLAN.md; `planWritesFile` false breaks the artifact. */
function handoffWorkflowFile(planWritesFile: boolean): string {
  const plan = {
    id: "plan",
    instructions: "Plan the endpoint.",
    agent: {
      adapter: "mock",
      options: {
        attempts: [{ edits: planWritesFile ? [{ path: "PLAN.md", content: PLAN }] : [], outputFields: { summary: "plan done" } }],
      },
    },
    verification: { requiredOutputFields: ["summary"] },
    artifacts: ["PLAN.md"],
  };
  const implement = {
    id: "implement",
    agent: { adapter: "mock", options: { attempts: [{}] } },
    verification: { command: "node ok.mjs" },
  };
  return `export default ${JSON.stringify({ name: "plan-implement", steps: [plan, implement] }, null, 2)};\n`;
}

describe("ahp run and ahp inspect with handoffs", () => {
  it("streams the handoffs and shows every handoff revision in full when inspecting", () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK, "workflow.mjs": handoffWorkflowFile(true) });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/step plan: handoff hnd_[a-z0-9]+ revision 1 issued/);
    expect(run.stdout).toMatch(/step implement: handoff hnd_[a-z0-9]+ revision 1 accepted/);
    expect(run.stdout).toMatch(/step plan: structural verification \[mock\]: checks only that/);
    const runId = /run (run_[a-z0-9]+): succeeded/.exec(run.stdout)?.[1];

    const inspect = ahp(["inspect", runId!, "--repo", repo], repo);

    expect(inspect.code).toBe(0);
    expect(inspect.stdout.match(/handoff hnd_[a-z0-9]+ revision 1: accepted/g)).toHaveLength(2);
    expect(inspect.stdout).toContain('"schemaVersion": "0.1.0"');
    expect(inspect.stdout).toContain(`"contextId": "${runId}"`);
    expect(inspect.stdout).toContain('"instructions": "Plan the endpoint."');
    expect(inspect.stdout).toContain('"summary": "plan done"');
    expect(inspect.stdout).toContain('"path": "PLAN.md"');
    expect(inspect.stdout).toContain(`"sha256": "${createHash("sha256").update(PLAN).digest("hex")}"`);
    expect(inspect.stdout).toContain("reported output fields: summary");
    expect(inspect.stdout).toContain("structural verification: checks only that");
    expect(inspect.stdout).toContain("evidence: required output fields (summary): all present");

    const json = (JSON.parse(ahp(["inspect", runId!, "--json"], repo).stdout) as RunInspection).state;
    expect(json.steps[1]?.handoffs[0]?.handoff.artifacts).toEqual([
      { path: "PLAN.md", sha256: createHash("sha256").update(PLAN).digest("hex") },
    ]);
  });

  it("shows every revision of a handoff in full, the superseded one as well as the current one", () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK, "workflow.mjs": handoffWorkflowFile(true) });
    const runId = /run (run_[a-z0-9]+): succeeded/.exec(ahp(["run", "workflow.mjs"], repo).stdout)?.[1]!;
    const first = (JSON.parse(ahp(["inspect", runId, "--json"], repo).stdout) as RunInspection).state.steps[1]!.handoffs[0]!.handoff;
    const second = { ...first, revision: 2, supersedes: 1, contract: { ...first.contract, instructions: "Revised instructions." } };
    appendLedgerEvent(repo, runId, { type: "handoff_issued", handoff: second });

    const inspect = ahp(["inspect", runId], repo);

    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain(`handoff ${first.handoffId} revision 1: superseded`);
    expect(inspect.stdout).toContain(`handoff ${first.handoffId} revision 2: issued`);
    const implement = inspect.stdout.slice(inspect.stdout.indexOf("step implement:"));
    expect(implement).toContain('"revision": 1');
    expect(implement).toContain('"instructions": null');
    expect(implement).toContain('"revision": 2');
    expect(implement).toContain('"supersedes": 1');
    expect(implement).toContain('"instructions": "Revised instructions."');
  });

  it("reports a rejected handoff with its machine-readable reason and runs no attempt for that step", () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK, "workflow.mjs": handoffWorkflowFile(false) });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/step implement: handoff hnd_[a-z0-9]+ revision 1 rejected \(unmet_dependency\)/);
    // No attempt ran for the step, so there is no mock result to label on its line; the run line carries the label.
    expect(run.stdout).toMatch(/step implement: failed \(rejected\)$/m);
    expect(run.stdout).toMatch(/run run_[a-z0-9]+: failed \[mock\]/);
    expect(run.stdout).not.toMatch(/step implement: attempt/);
    const runId = /run (run_[a-z0-9]+): failed/.exec(run.stdout)?.[1];

    const inspect = ahp(["inspect", runId!], repo);

    expect(inspect.stdout).toMatch(/rejected \(unmet_dependency\) at \/requires\/artifacts\/0: .*PLAN\.md/);
    expect(inspect.stdout).toMatch(/handoff hnd_[a-z0-9]+ revision 1: rejected/);
  });

  it("rejects a parallel workflow without starting a run", () => {
    const parallel = {
      name: "fan-out",
      steps: [
        [
          { id: "a", agent: { adapter: "mock", options: { attempts: [{}] } }, verification: { command: "node ok.mjs" } },
          { id: "b", agent: { adapter: "mock", options: { attempts: [{}] } }, verification: { command: "node ok.mjs" } },
        ],
      ],
    };
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK, "workflow.mjs": `export default ${JSON.stringify(parallel)};\n` });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('steps "a", "b"');
    expect(run.stderr).toContain("parallel group");
    expect(run.stdout).toBe("");
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
