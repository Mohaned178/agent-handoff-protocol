import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.ts";
import { formatBriefReceipt, formatReceipt, nextStepOf } from "../src/cli/receipt.ts";
import { defineWorkflow, mock, runWorkflow, type MockAttemptScript, type StepDefinition } from "../src/index.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { goodbye, hello, retryWorkflow } from "./helpers/retry.ts";

afterEach(removeTempRepos);

const HEADING = "what the checks found (from the run's ledger: an agent's report is a claim, a check decides):";
const repo = () => createTempRepo({ "verify.mjs": VERIFY_GREETING });
/** The receipt above its usage lines, which are the usage summary's own. */
const checks = (state: Parameters<typeof formatReceipt>[0]) => formatReceipt(state).split("\nusage, as each tool reported it")[0];
const done = (script: MockAttemptScript): MockAttemptScript => ({ ...script, outputFields: { summary: "done" } });

/** implement (verified by `node verify.mjs`) → review, which may send it back. */
function reviewed(implement: MockAttemptScript[], review: MockAttemptScript[], implementStep: Partial<StepDefinition> = {}) {
  return defineWorkflow({
    name: "reviewed",
    steps: [
      { id: "implement", agent: mock({ attempts: implement }), verification: { command: "node verify.mjs", requiredOutputFields: ["summary"] }, ...implementStep },
      { id: "review", agent: mock({ attempts: review }), review: { sendBackTo: "implement" }, verification: {} },
    ],
  });
}
const approve: MockAttemptScript = { outputFields: { verdict: "approved", findings: "nothing left" } };
const changes: MockAttemptScript = { outputFields: { verdict: "changes_requested", findings: ["rename the greeting", "add a test"] } };

describe("the run receipt", () => {
  it("says only that the work was verified, and the usage, when the first attempt passed", async () => {
    const { state } = await runWorkflow(retryWorkflow([hello]), { repo: repo() });

    expect(formatReceipt(state)).toBe(
      [
        HEADING,
        "  implement: verified: `node verify.mjs` passed in a clean copy",
        "usage, as each tool reported it (per adapter, not summed across adapters; nothing is estimated):",
        "  mock: none reported by 1 attempt",
      ].join("\n"),
    );
  });

  it("counts the times an agent reported done before its check passed, with the first failing line of each", async () => {
    const { state } = await runWorkflow(retryWorkflow([goodbye, { edits: [{ path: "greeting.txt", content: "hi\n" }] }, hello]), { repo: repo() });

    expect(checks(state)).toBe(
      [
        HEADING,
        "  implement: verified: `node verify.mjs` passed in a clean copy",
        "  implement: the agent reported done 2 times before its check passed:",
        "    attempt 1: greeting missing or wrong",
        "    attempt 2: greeting missing or wrong",
      ].join("\n"),
    );
  });

  it("says when the check never passed", async () => {
    const { state } = await runWorkflow(retryWorkflow([goodbye], { retry: { budget: 0 } }), { repo: repo() });

    expect(checks(state)).toBe(
      [
        HEADING,
        "  implement: not verified: `node verify.mjs` failed",
        "  implement: the agent reported done 1 time; its check never passed:",
        "    attempt 1: greeting missing or wrong",
      ].join("\n"),
    );
  });

  it("lists what a review sent back, one finding a line, and whether the revision was approved", async () => {
    const { state } = await runWorkflow(reviewed([done(hello), done(hello)], [changes, approve]), { repo: repo() });

    expect(checks(state)).toBe(
      [
        HEADING,
        "  implement: verified: `node verify.mjs` passed in a clean copy",
        "  implement: sent back by review (attempt 1):",
        "    | rename the greeting",
        "    | add a test",
        "    the next review approved the revision",
      ].join("\n"),
    );
  });

  it("says when the next review asked for changes again", async () => {
    const { state } = await runWorkflow(reviewed([done(hello), done(hello)], [changes, changes], { retry: { budget: 1 } }), { repo: repo() });

    expect(formatReceipt(state)).toContain("  implement: sent back by review (attempt 1):\n    | rename the greeting\n    | add a test\n    the next review asked for changes again");
  });

  it("says the work is not verified when no step has a check command", async () => {
    const workflow = defineWorkflow({ name: "unchecked", steps: [{ id: "implement", agent: mock({ attempts: [done(hello)] }), verification: { requiredOutputFields: ["summary"] } }] });

    const { state } = await runWorkflow(workflow, { repo: repo() });

    expect(checks(state)).toBe([HEADING, "  not verified: no check command"].join("\n"));
  });

  it("names what was refused: a protected path an agent changed, and a handoff its adapter could not take", async () => {
    const tampered: MockAttemptScript = { edits: [{ path: "verify.mjs", content: "process.exit(0);\n" }] };
    const { state } = await runWorkflow(retryWorkflow([tampered, hello], { verification: { command: "node verify.mjs", protectedPaths: ["verify.mjs"] } }), { repo: repo() });

    expect(formatReceipt(state)).toContain("    attempt 1: refused: it changed a protected path (modified verify.mjs), so its check was not run");

    const rejected = await runWorkflow(retryWorkflow([hello], { capabilities: [{ kind: "read_only", require: "enforced_by_tool" }] }), { repo: repo() });
    expect(formatReceipt(rejected.state)).toContain(
      `  implement: refused: its handoff (revision 1): adapter "mock" applies read_only at most at "cooperative" on ${process.platform}, and the handoff requires "enforced_by_tool"`,
    );
  });

  it("ends with the usage each tool reported, as before", async () => {
    const reported: MockAttemptScript = { ...hello, usage: { inputTokens: 120, outputTokens: 30 } };

    const { state } = await runWorkflow(retryWorkflow([reported]), { repo: repo() });

    expect(formatReceipt(state)).toMatch(/passed in a clean copy\nusage, as each tool reported it/);
  });
});

describe("the receipt in the CLI", () => {
  it("is printed at a run's end and at the top of ahp inspect", async () => {
    const dir = createTempRepo({
      "verify.mjs": VERIFY_GREETING,
      "workflow.mjs": `export default ${JSON.stringify({ name: "retry", steps: [{ id: "implement", agent: { adapter: "mock", options: { attempts: [goodbye, hello] } }, verification: { command: "node verify.mjs" } }] })};\n`,
    });
    const ahpHere = async (args: string[]) => {
      const printed: string[] = [];
      const code = await main([...args, "--repo", dir], { stdout: (text) => printed.push(text), stderr: (text) => printed.push(text) });
      return { code, stdout: printed.join("\n") };
    };

    const run = await ahpHere(["run", join(dir, "workflow.mjs")]);

    expect(run.code, run.stdout).toBe(0);
    const receipt = `${HEADING}\n  implement: verified: \`node verify.mjs\` passed in a clean copy\n  implement: the agent reported done 1 time before its check passed:\n    attempt 1: greeting missing or wrong`;
    expect(run.stdout.indexOf(receipt)).toBeGreaterThan(run.stdout.search(/run run_[a-z0-9]+: succeeded/));
    const runId = /run (run_[a-z0-9]+): succeeded/.exec(run.stdout)![1]!;

    const inspect = await ahpHere(["inspect", runId]);

    expect(inspect.stdout.split("\n").slice(1, 5).join("\n")).toBe(receipt.split("\n").map((line) => `  ${line}`).join("\n"));
  });
});

describe("the short receipt a terminal shows", () => {
  it("says each check in one line, with its failed attempts and send-backs, then usage", async () => {
    const { state } = await runWorkflow(reviewed([done(goodbye), done(hello), done(hello)], [changes, approve]), { repo: repo() });

    expect(formatBriefReceipt(state)).toEqual([
      "✓ implement: `node verify.mjs` passed · after one failed attempt · sent back once, approved after",
      "usage: mock reported none",
    ]);
  });

  it("says the work is not verified when no step ran a check, and names a refusal", async () => {
    const unchecked = defineWorkflow({ name: "unchecked", steps: [{ id: "implement", agent: mock({ attempts: [done(hello)] }), verification: { requiredOutputFields: ["summary"] } }] });
    expect(formatBriefReceipt((await runWorkflow(unchecked, { repo: repo() })).state)[0]).toBe("! not verified: no check command");

    const tampered: MockAttemptScript = { edits: [{ path: "verify.mjs", content: "process.exit(0);\n" }] };
    const { state } = await runWorkflow(retryWorkflow([tampered, hello], { verification: { command: "node verify.mjs", protectedPaths: ["verify.mjs"] } }), { repo: repo() });
    expect(formatBriefReceipt(state)).toContain("! implement: attempt 1 changed a protected path (modified verify.mjs), so its check was not run");
  });

  it("shortens reported numbers and keeps their source", async () => {
    const reported: MockAttemptScript = { ...hello, usage: { inputTokens: 18_240, outputTokens: 2_100, cost: { amount: 0.25, currency: "USD" } } };

    const { state } = await runWorkflow(retryWorkflow([reported]), { repo: repo() });

    expect(formatBriefReceipt(state).at(-1)).toMatch(/^usage: mock 18\.2k in · 2\.1k out · 0\.25 USD \(as reported; .+\)$/);
  });

  it("names the one command to run next, by how the run stopped", async () => {
    expect(nextStepOf((await runWorkflow(retryWorkflow([goodbye], { retry: { budget: 0 } }), { repo: repo() })).state)).toMatch(/^ahp inspect run_[a-z0-9]+ shows every attempt and its evidence$/);
    expect(nextStepOf((await runWorkflow(retryWorkflow([hello]), { repo: repo() })).state)).toBeNull();
  });
});
