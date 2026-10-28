import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallLogEntry } from "../src/index.ts";
import { describeChanges, formatDiff } from "../src/cli/diff.ts";
import { describeToolCall, span, watchProgress } from "../src/cli/progress.ts";
import { snapshotMessage } from "../src/runtime/run.ts";
import { ahp } from "./helpers/cli.ts";
import { until } from "./helpers/process.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

const dirs: string[] = [];
afterEach(() => {
  removeTempRepos();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ahp-guidance-"));
  dirs.push(dir);
  return dir;
};

const workflow = (content: string) => `export default {
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

describe("ahp run says which repository it uses", () => {
  it("names the repository before the run starts", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow("hello\n") });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.code).toBe(0);
    expect(run.stdout.split("\n")[0]).toBe(`repository: ${repo}`);
  });

  it("refuses a home folder kept under git unless --repo names it", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow("hello\n") });
    const sub = join(repo, "projects", "new");
    mkdirSync(sub, { recursive: true });
    const home = { HOME: repo, USERPROFILE: repo };

    const refused = ahp(["run", join(repo, "workflow.mjs")], sub, home);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(`the git repository around ${sub} is your home folder (${repo})`);
    expect(refused.stderr).not.toContain("Usage: ahp");
    expect(refused.stdout).not.toContain("created");

    const named = ahp(["run", join(repo, "workflow.mjs"), "--repo", repo], sub, home);
    expect(named.code).toBe(0);
  });

  it("says plainly when there is no repository, and points to --help instead of printing it", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "workflow.mjs"), workflow("hello\n"));

    const run = ahp(["run", "workflow.mjs"], dir, { GIT_CEILING_DIRECTORIES: dirname(dir) });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`${dir} is not in a git repository: run ahp in your project's folder, or pass --repo <dir>`);
    expect(run.stderr).toContain("`ahp --help` lists the commands and options");
    expect(run.stderr).not.toContain("Usage: ahp");
  });
});

describe("a failed run says why", () => {
  it("shows the last attempt's verification output and where to look further", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow("goodbye\n") });

    const run = ahp(["run", "workflow.mjs"], repo);
    const runId = /run (run_[a-z0-9]+): failed/.exec(run.stdout)?.[1];

    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/retry budget spent\n {2}last attempt att_[a-z0-9]+ failed verification: node verify\.mjs\n/);
    expect(run.stdout).toContain("| greeting missing or wrong");
    expect(run.stdout).toContain(`every attempt, handoff and verification: ahp inspect ${runId}`);
  });
});

describe("progress while an agent runs", () => {
  const entry = (changes: Partial<ToolCallLogEntry>): ToolCallLogEntry => ({
    time: "2026-10-28T00:00:00.000Z",
    toolCallId: "call_1",
    kind: "edit",
    title: "src/app.mjs",
    status: "pending",
    paths: ["src/app.mjs"],
    permission: null,
    ...changes,
  });

  it("says each tool call once it has finished or was refused, and a heartbeat with the time since the tool last printed", async () => {
    const dir = tempDir();
    const files = { output: join(dir, "out.txt"), toolCalls: join(dir, "calls.jsonl") };
    writeFileSync(files.output, "started\n");
    const lines: string[] = [];
    const watch = watchProgress(files, "step implement: attempt att_1", (line) => lines.push(line), { heartbeatMs: 150, pollMs: 20 });
    try {
      appendFileSync(files.toolCalls, `${JSON.stringify(entry({}))}\n${JSON.stringify(entry({ status: "in_progress" }))}\n`);
      appendFileSync(files.toolCalls, `${JSON.stringify(entry({ status: "completed" }))}\n${JSON.stringify(entry({ toolCallId: "call_2", kind: "execute", title: "git push", permission: "rejected" }))}\n`);
      await until(() => (lines.some((line) => line.includes("still running")) ? true : undefined), "a heartbeat");
    } finally {
      watch.stop();
    }

    expect(lines.filter((line) => !line.includes("still running"))).toEqual([
      "step implement: attempt att_1: edit src/app.mjs",
      "step implement: attempt att_1: execute git push (refused by AHP)",
    ]);
    expect(lines.find((line) => line.includes("still running"))).toMatch(/^step implement: attempt att_1: still running \(\d+s; its tool last printed \d+s ago\)$/);
    const said = lines.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(lines).toHaveLength(said);
  });

  it("describes calls and spans", () => {
    expect(describeToolCall(entry({ status: "in_progress" }))).toBeNull();
    expect(describeToolCall(entry({ status: "failed", kind: null, title: null }))).toBe("tool src/app.mjs (failed)");
    expect([span(4_000), span(185_000), span(3_720_000)]).toEqual(["4s", "3m 5s", "1h 2m"]);
  });
});


describe("the code, shown", () => {
  const gated = `export default {
  name: "greeting",
  steps: [
    {
      id: "implement",
      agent: { adapter: "mock", options: { attempts: [{ edits: [{ path: "greeting.txt", content: "hello\\n" }], outputFields: { summary: "Wrote the greeting.\\nMore detail." } }] } },
      verification: { command: "node verify.mjs" },
    },
    { id: "approve", approval: {} },
  ],
};
`;

  it("says what each attempt changed, and shows the diff being approved before the choices", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": gated });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(4);
    expect(run.stdout).toMatch(/attempt att_[a-z0-9]+ \[mock\] snapshot [0-9a-f]{12}: changed greeting\.txt \(\+1 -0\)\n/);
    const gate = run.stdout.slice(run.stdout.indexOf("waiting for approval"));
    expect(gate).toContain("  what you are approving: changed greeting.txt (+1 -0)\n");
    expect(gate).toContain("    +hello\n");
    // The choices come last, after the diff, where they are seen.
    expect(gate.indexOf("+hello")).toBeLessThan(gate.indexOf("`ahp approve "));
    // Not a terminal, so no color codes.
    expect(run.stdout).not.toContain("\u001b[");
  });

  it("prints every attempt's whole diff with --diff", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow("hello\n") });

    const run = ahp(["run", "workflow.mjs", "--diff"], repo);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/snapshot [0-9a-f]{12}: changed greeting\.txt \(\+1 -0\)\n {4}diff --git a\/greeting\.txt b\/greeting\.txt\n/);
  });

  it("names a snapshot commit after what the agent said it did, and says that is the agent's claim", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": gated });

    const run = ahp(["run", "workflow.mjs"], repo);
    const commit = /snapshot ([0-9a-f]{12})/.exec(run.stdout)![1]!;
    const message = spawnSync("git", ["log", "-1", "--format=%B", commit], { cwd: repo, encoding: "utf8" }).stdout;

    expect(message).toMatch(/^implement: Wrote the greeting\.\n\nAHP snapshot of run_[a-z0-9]+ step implement attempt att_[a-z0-9]+\. The subject is the coding agent's own report, not a verified fact\.\n/);
    expect(snapshotMessage("run_x", "review", { id: "att_y", reportedOutput: { verdict: "approved" } }).split("\n")[0]).toBe("review: approved");
    expect(snapshotMessage("run_x", "plan", { id: "att_y", reportedOutput: {} }).split("\n")[0]).toBe("plan: (the agent reported no summary)");
    expect(snapshotMessage("run_x", "plan", { id: "att_y", reportedOutput: { summary: "x".repeat(100) } }).split("\n")[0]).toHaveLength("plan: ".length + 64);
  });

  it("cuts a long diff with where to read the rest, and colors it for a terminal", () => {
    const diff = ["diff --git a/x b/x", "@@ -1 +1 @@", "-old", "+new", ...Array.from({ length: 10 }, (_, i) => ` line ${i}`)].join("\n");

    expect(formatDiff(diff, { color: false, maxLines: 4, more: "ahp inspect run_x" }).split("\n")).toEqual([
      "    diff --git a/x b/x",
      "    @@ -1 +1 @@",
      "    -old",
      "    +new",
      "    ... 10 more lines: ahp inspect run_x",
    ]);
    expect(formatDiff("+new\n-old", { color: true, more: "" })).toBe("    \u001b[32m+new\u001b[0m\n    \u001b[31m-old\u001b[0m");
    expect(describeChanges([])).toBe("changed nothing");
    expect(describeChanges([{ path: "a.png", added: null, removed: null }, ...Array.from({ length: 6 }, (_, i) => ({ path: `f${i}`, added: 1, removed: 2 }))])).toBe(
      "changed a.png (binary), f0 (+1 -2), f1 (+1 -2), f2 (+1 -2), f3 (+1 -2), and 2 more",
    );
  });
});
