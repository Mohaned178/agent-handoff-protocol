import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli/main.ts";
import type { Terminal } from "../src/cli/live.ts";
import type { Prompter } from "../src/setup/index.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

afterEach(() => removeTempRepos());

const hello = { edits: [{ path: "greeting.txt", content: "hello\n" }], outputFields: { summary: "Wrote the greeting." } };
const wrong = { edits: [{ path: "greeting.txt", content: "goodbye\n" }], outputFields: { summary: "Wrote a greeting." } };

const workflow = (attempts: object[], { gate = false, budget = 2 } = {}) => `export default {
  name: "greeting",
  steps: [
    {
      id: "implement",
      agent: { adapter: "mock", options: { attempts: ${JSON.stringify(attempts)} } },
      verification: { command: "node verify.mjs" },
      retry: { budget: ${budget} },
    },
    ${gate ? `{ id: "approve", approval: {} },` : ""}
  ],
};
`;

/** A person at the terminal who gives these answers, in order. */
function person(answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = async <T>(message: string) => {
    asked.push(message);
    if (answers.length === 0) throw new Error(`no answer scripted for: ${message}`);
    return answers.shift() as T;
  };
  return {
    asked,
    select: ({ message }) => next(message),
    checkbox: ({ message }) => next(message),
    input: ({ message }) => next(message),
    confirm: ({ message }) => next(message),
    say: () => undefined,
  };
}

/** Runs `ahp` in this process with a terminal: what was printed line by line, and what was drawn in place. */
async function inTerminal(args: string[], repo: string, options: { prompter?: Prompter | null; compact?: boolean } = {}) {
  const printed: string[] = [];
  let drawn = "";
  const terminal: Terminal = {
    write: (text) => {
      drawn += text;
    },
    columns: () => 100,
    color: false,
    compact: options.compact ?? true,
    prompter: options.prompter ?? null,
  };
  const io: Io = { stdout: (text) => printed.push(text), stderr: (text) => printed.push(`stderr: ${text}`), terminal };
  const code = await main([...args, "--repo", repo], io);
  return { code, stdout: printed.join("\n"), drawn };
}

describe("the compact run view in a terminal", () => {
  it("shows one line per step with what it changed, and no internal events", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow([hello]) });

    const run = await inTerminal(["run", join(repo, "workflow.mjs")], repo);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`ahp · greeting · ${repo.replaceAll("\\", "\\\\")} · run_[a-z0-9]+\\n`));
    expect(run.stdout).toMatch(/\n {2}✓ implement {3}mock · \d+s\n {6}changed greeting\.txt \(\+1 -0\)\n/);
    expect(run.stdout).toMatch(/✓ run succeeded in \d+s\n {2}✓ implement: `node verify\.mjs` passed\n {2}usage: mock reported none\n/);
    expect(run.stdout).not.toContain("handoff");
    expect(run.stdout).not.toContain("shared refs");
    expect(run.stdout).not.toContain("repository:");
  });

  it("says in one line why an attempt is retried, with the line of its check's output that says what failed", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow([wrong, hello]) });

    const run = await inTerminal(["run", join(repo, "workflow.mjs")], repo);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("\n  ↻ implement   check failed: greeting missing or wrong · trying again\n  ✓ implement");
    expect(run.stdout).toContain("✓ implement: `node verify.mjs` passed · after one failed attempt");
  });

  it("marks a failed step, says why it stopped in one line, and names the command that shows the rest", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow([wrong], { budget: 0 }) });

    const run = await inTerminal(["run", join(repo, "workflow.mjs")], repo);

    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/✗ implement {3}mock · \d+s\n {6}retry budget spent: greeting missing or wrong\n/);
    expect(run.stdout).toMatch(/✗ run failed\n {2}✗ implement: `node verify\.mjs` failed on one attempt\n/);
    expect(run.stdout).toMatch(/next: ahp inspect run_[a-z0-9]+ shows every attempt and its evidence/);
  });

  it("keeps to its text budget: no line wider than the terminal, and a short end", async () => {
    const long = { edits: [{ path: "greeting.txt", content: "goodbye\n" }], outputFields: { summary: "x" } };
    const repo = createTempRepo({ "verify.mjs": `console.log("${"a very long failing line ".repeat(10)}"); process.exit(1);\n`, "workflow.mjs": workflow([long, long, long]) });

    const run = await inTerminal(["run", join(repo, "workflow.mjs")], repo);

    // The terminal is 100 columns; a long repository path in the heading is the one line allowed to run on.
    const lines = run.stdout.split("\n").filter((line) => !line.startsWith("ahp · "));
    expect(lines.filter((line) => line.length > 100)).toEqual([]);
    const end = run.stdout.slice(run.stdout.indexOf("✗ run failed")).split("\n").slice(1);
    expect(end.length).toBeLessThanOrEqual(5);
  });

  it("prints the whole log with --verbose", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow([hello]) });

    const run = await inTerminal(["run", join(repo, "workflow.mjs"), "--verbose"], repo);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`repository: ${repo}`);
    expect(run.stdout).toContain("step implement: ready");
    expect(run.drawn).toBe("");
  });
});

describe("deciding a gate in place", () => {
  it("approves when the person chooses Approve, and the run goes on to its end", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow([hello], { gate: true }) });
    const prompter = person(["approve"]);

    const run = await inTerminal(["run", join(repo, "workflow.mjs")], repo, { prompter });

    expect(run.code).toBe(0);
    expect(prompter.asked).toEqual(["Approve this change?"]);
    const gate = run.stdout.indexOf("? waiting for your approval");
    expect(run.stdout.indexOf("+hello")).toBeGreaterThan(gate);
    // Asked in place, so the commands to decide it later are not printed.
    expect(run.stdout).not.toContain("`ahp approve ");
    expect(run.stdout).toMatch(/✓ approve {5}approved by \S+/);
    expect(run.stdout).toMatch(/✓ run succeeded/);
  });

  it("sends the work back with the reason typed, then stops at the gate again", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow([hello, hello], { gate: true }) });
    const prompter = person(["diff", "reject", "Say it louder", "approve"]);

    const run = await inTerminal(["run", join(repo, "workflow.mjs")], repo, { prompter });

    expect(run.code).toBe(0);
    expect(prompter.asked).toEqual(["Approve this change?", "Approve this change?", "Why? (the agent is given this)", "Approve this change?"]);
    expect(run.stdout).toContain("↩ approve     rejected; implement goes back with your reason");
    expect(run.stdout.match(/✓ implement {3}/g)).toHaveLength(2); // the first attempt, then the revision
    expect(run.stdout.match(/ahp · greeting/g)).toHaveLength(1);
    expect(run.stdout.match(/scripted mock agents: their results are not evidence/g)).toHaveLength(1);
    expect(run.stdout.match(/\? waiting for your approval/g)).toHaveLength(2);
    // Usage is said once, at the run's end, over both attempts: not at each gate the person decided.
    expect(run.stdout.match(/usage: mock/g)).toHaveLength(1);
    expect(run.stdout.indexOf("usage: mock reported none")).toBeGreaterThan(run.stdout.search(/✓ run succeeded/));
  });

  it("leaves the run waiting, with the commands to decide it, when the person decides later", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow([hello], { gate: true }) });

    const run = await inTerminal(["run", join(repo, "workflow.mjs")], repo, { prompter: person(["later"]) });

    expect(run.code).toBe(4);
    expect(run.stdout).toMatch(/`ahp approve run_[a-z0-9]+ approve` lets the run go on/);
    expect(run.stdout.match(/usage: mock/g)).toHaveLength(1);
  });

  it("prints the commands instead of asking when no one can answer", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow([hello], { gate: true }) });

    const run = await inTerminal(["run", join(repo, "workflow.mjs")], repo, { prompter: null });

    expect(run.code).toBe(4);
    expect(run.stdout).toContain("? waiting for your approval");
    expect(run.stdout).toMatch(/`ahp approve run_[a-z0-9]+ approve` lets the run go on/);
  });
});
