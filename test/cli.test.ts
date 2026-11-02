import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunInspection } from "../src/index.ts";
import { plain as ahp } from "./helpers/cli.ts";
import { appendLedgerEvent, ledgerLines } from "./helpers/ledger.ts";
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
  it("runs a workflow, says each step that ends and the receipt, labelled as mock, and inspects the derived state", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflowFile("hello\n") });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    // The run's ID the moment it exists, a line for the step that ended, then the run's end, its receipt and the mock note.
    expect(run.stdout).toMatch(/^run run_[a-z0-9]+: created · greeting$/m);
    expect(run.stdout).toMatch(/^✓ implement {2}succeeded \[mock\]$/m);
    expect(run.stdout).toMatch(/^run run_[a-z0-9]+: succeeded \[mock\]$/m);
    expect(run.stdout).toContain("✓ implement: `node verify.mjs` passed");
    expect(run.stdout).toContain("scripted mock agents: their results are not evidence");
    expect(run.stdout).not.toContain("next:");
    // The plumbing (attempt created, running, verifying) is the ledger's and inspect's, not the run's lines.
    expect(run.stdout.split("\n").length).toBeLessThan(12);
    const runId = /run (run_[a-z0-9]+): succeeded/.exec(run.stdout)?.[1];
    expect(runId).toBeDefined();

    const inspect = ahp(["inspect", runId!, "--repo", repo], join(repo, ".."));

    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain(`run ${runId}: succeeded [mock]`);
    expect(inspect.stdout).toMatch(/step implement: succeeded \[mock\]/);
    expect(inspect.stdout).toMatch(/attempt \S+ \[mock\]: exited ok \(exit code 0\)/);
    expect(inspect.stdout).toMatch(/verification: pass/);
    expect(inspect.stdout).toContain("command: node verify.mjs");
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
    expect(run.stdout).toMatch(/^✗ implement {2}failed \(verification_failed\) \[mock\]$/m);
    expect(run.stdout).toMatch(/^run run_[a-z0-9]+: failed \[mock\]$/m);
    expect(run.stdout).toContain("✗ implement: `node verify.mjs` failed on one attempt");
    expect(run.stdout).toMatch(/^next: ahp inspect run_[a-z0-9]+ shows every attempt and its evidence$/m);
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

  it("prints the usage, and exits 0, when given no command", () => {
    const result = ahp([], process.cwd());

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('ahp "<task>" --yes');
    expect(result.stdout).toContain("Exit codes:");
  });

  it("prints usage and exits 2 for an unknown command", () => {
    const result = ahp(["launch"], process.cwd());

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command: launch");
    expect(result.stderr).toContain("Usage: ahp");
  });

  it("refuses unquoted words as a task, with the quoted form to use", () => {
    const result = ahp(["fix", "the", "bug"], process.cwd());

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command: fix (a task is one argument, in quotes: ahp "fix the bug")');
  });

  it("lists every plain command in one usage text, as --help and help print it", () => {
    const help = ahp(["--help"], process.cwd());

    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    for (const command of [
      "run <workflow-file>",
      "approve <run-id> [<gate>]",
      "reject <run-id> [<gate>]",
      "recover <run-id|attempt-id>",
      "runs",
      "inspect [<run-id>]",
      "doctor",
      "clean",
      "demo",
      "eval <suite-file>",
      "bench <bench-file>",
      "bench report <bench-dir>... [--eval <eval-dir>]...",
      "Exit codes:",
    ]) {
      expect(help.stdout).toContain(command);
    }
    for (const gone of ["setup", "settings", "init"]) expect(help.stdout).not.toContain(`  ${gone}`);
    const word = ahp(["help"], process.cwd());
    expect(word.code).toBe(0);
    expect(word.stdout).toBe(help.stdout);
    const invalid = ahp(["help", "everything"], process.cwd());
    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("unexpected argument: everything");
  });

  it("refuses an option a command does not have with that command's usage line, and sends the retired commands to the app", () => {
    const flag = ahp(["runs", "--bogus"], process.cwd());
    expect(flag.code).toBe(2);
    expect(flag.stdout).toBe("");
    expect(flag.stderr).toContain("unknown option '--bogus'");
    expect(flag.stderr).toContain("usage: ahp runs [--all] [--json] [--repo <dir>]");
    expect(flag.stderr).not.toContain("approve");

    // An option another command has is as unknown here.
    const other = ahp(["doctor", "--reason", "x"], process.cwd());
    expect(other.code).toBe(2);
    expect(other.stderr).toContain("usage: ahp doctor [--json]");
    const missing = ahp(["run"], process.cwd());
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("run needs a workflow file\nusage: ahp run <workflow-file> [--repo <dir>]");

    for (const retired of ["setup", "settings", "init"]) {
      const moved = ahp([retired], process.cwd());
      expect(moved.code).toBe(2);
      expect(moved.stderr).toContain(`\`ahp ${retired}\` has moved into the app`);
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
    const runId = /run (run_[a-z0-9]+): succeeded/.exec(run.stdout)?.[1];
    // The handoffs are the ledger's and inspect's: the run's own lines say only what ended.
    expect(run.stdout).not.toContain("handoff");
    expect(ledgerLines(repo, runId!).filter((event) => event.type === "handoff_issued")).toHaveLength(2);
    expect(ledgerLines(repo, runId!).filter((event) => event.type === "handoff_accepted")).toHaveLength(2);

    const inspect = ahp(["inspect", runId!, "--repo", repo], repo);

    expect(inspect.code).toBe(0);
    expect(inspect.stdout.match(/handoff hnd_[a-z0-9]+ revision 1: accepted/g)).toHaveLength(2);
    expect(inspect.stdout).toContain('"schemaVersion": "0.2.0"');
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
    expect(run.stdout).toMatch(/^! implement {2}handoff hnd_[a-z0-9]+ revision 1 rejected \(unmet_dependency\)$/m);
    // No attempt ran for the step, so there is no mock result to label on its line; the run line carries the label.
    expect(run.stdout).toMatch(/^✗ implement {2}failed \(rejected\)$/m);
    expect(run.stdout).toMatch(/^run run_[a-z0-9]+: failed \[mock\]$/m);
    expect(run.stdout).toContain("implement: refused: its handoff (revision 1)");
    const runId = /run (run_[a-z0-9]+): failed/.exec(run.stdout)?.[1];
    const implement = (JSON.parse(ahp(["inspect", runId!, "--json"], repo).stdout) as RunInspection).state.steps.find((step) => step.id === "implement")!;
    expect(implement.attempts).toEqual([]);

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
