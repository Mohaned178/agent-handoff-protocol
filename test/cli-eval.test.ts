import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GREETS, greetingFiles, writeTree } from "./helpers/evaluation.ts";
import { ahp } from "./helpers/cli.ts";
import { removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const SCRIPT = GREETS;

/** A suite file beside its task, as a person would lay them out: the task is named relative to the file. */
function suiteDir(suite: Record<string, unknown> = {}, task = greetingFiles()) {
  const spec = { name: "cli-suite", tasks: ["./greeting"], conditions: ["C0"], agents: { implement: { adapter: "mock", options: { attempts: [SCRIPT] } } }, ...suite };
  const files: Record<string, string> = { "suite.mjs": `export default ${JSON.stringify(spec, null, 2)};\n` };
  for (const [path, content] of Object.entries(task)) files[`greeting/${path}`] = content;
  return writeTree(files);
}

describe("ahp eval", () => {
  it("runs the suite, streams what happens, prints the report with the mock label, and exits 0", () => {
    const dir = suiteDir();
    const out = writeTree({});

    const { code, stdout, stderr } = ahp(["eval", "suite.mjs", "--out", out], dir);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain('task greeting frozen');
    expect(stdout).toContain("trial C0 greeting #1: started");
    expect(stdout).toContain("trial C0 greeting #1: scored, pass");
    expect(stdout).toContain("verified success: 1 of 1 scored trials (100%)");
    expect(stdout).toContain("[mock]");
    const [id] = readdirSync(out);
    expect(existsSync(join(out, id!, "ledger.jsonl"))).toBe(true);
    expect(readFileSync(join(out, id!, "report.txt"), "utf8")).toContain("verified success: 1 of 1 scored trials (100%)");
  });

  it("keeps its evaluations under the per-user AHP directory when no --out is given", () => {
    const dir = suiteDir();
    const home = writeTree({});

    const { code } = ahp(["eval", "suite.mjs"], dir, { AHP_HOME: home });

    expect(code).toBe(0);
    const [id] = readdirSync(join(home, "evaluations"));
    expect(existsSync(join(home, "evaluations", id!, "report.json"))).toBe(true);
  });

  it("prints just the report as JSON with --json", () => {
    const dir = suiteDir();

    const { code, stdout } = ahp(["eval", "suite.mjs", "--out", writeTree({}), "--json"], dir);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ suite: "cli-suite", state: "completed", mock: true, conditions: [{ condition: "C0", scored: 1, passes: 1, successRate: 1 }] });
  });

  it("reports a harness incident as one, apart from the rates, and still exits 0: the evaluation completed", () => {
    const dir = suiteDir({ agents: { implement: { adapter: "mock", options: { attempts: [{ ...SCRIPT, loseContact: true }] } } } });

    const { code, stdout } = ahp(["eval", "suite.mjs", "--out", writeTree({})], dir);

    expect(code).toBe(0);
    expect(stdout).toContain("trial C0 greeting #1: harness incident, not scored");
    expect(stdout).toContain("harness incidents (excluded, not failures): 1");
    expect(stdout).toContain("verified success: n/a: no scored trials");
  });

  it("refuses a suite that is invalid with a usage error, naming the problem, and writes nothing", () => {
    const dir = suiteDir({ conditions: ["C3"], agents: { implement: { adapter: "mock", options: { attempts: [SCRIPT] } } } });
    const out = writeTree({});

    const { code, stderr } = ahp(["eval", "suite.mjs", "--out", out], dir);

    expect(code).toBe(2);
    expect(stderr).toContain("`agents.plan` is needed");
    expect(readdirSync(out)).toEqual([]);
  });

  it("refuses a task that is invalid, a missing suite file and a missing argument", () => {
    const bad = suiteDir({}, greetingFiles({ prompt: "" }));
    expect(ahp(["eval", "suite.mjs", "--out", writeTree({})], bad)).toMatchObject({ code: 2, stderr: expect.stringContaining("non-empty `prompt`") });
    expect(ahp(["eval", "missing.mjs"], bad)).toMatchObject({ code: 2, stderr: expect.stringContaining("cannot load suite file") });
    expect(ahp(["eval"], bad)).toMatchObject({ code: 2, stderr: expect.stringContaining("eval needs a suite file") });
  });

  it("lists eval among the commands", () => {
    expect(ahp(["--help"], writeTree({})).stdout).toContain("eval <suite-file>");
  });

  it("shuffles the trials by the --seed given, says so, and refuses a seed that is not an unsigned 32-bit integer", () => {
    const dir = suiteDir({ repeats: 2 });

    const { code, stdout } = ahp(["eval", "suite.mjs", "--out", writeTree({}), "--seed", "4294967295"], dir);

    expect(code).toBe(0);
    expect(stdout).toContain("2 trials scheduled in a shuffled order (seed 4294967295)");
    expect(stdout).toContain("trial C0 greeting #2: scored, pass");
    for (const bad of ["4294967296", "-1", "1.5", "abc"]) {
      expect(ahp(["eval", "suite.mjs", "--out", writeTree({}), `--seed=${bad}`], dir)).toMatchObject({ code: 2, stderr: expect.stringContaining("--seed must be an integer from 0 to 4294967295") });
    }
  });
});

