import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallLogEntry } from "../src/index.ts";
import { describeToolCall, span, watchProgress } from "../src/cli/progress.ts";
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

