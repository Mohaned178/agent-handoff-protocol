import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MockAttemptScript } from "../src/index.ts";
import { ahp } from "./helpers/cli.ts";
import { finishedRun, ledgerLines } from "./helpers/ledger.ts";
import { isRunning, startRun, until, untilGone } from "./helpers/process.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { hello } from "./helpers/retry.ts";

afterEach(removeTempRepos);

/** A workflow file whose one step's mock agent runs `attempts` and whose verification wants "hello" in greeting.txt. */
const workflowFile = (attempts: MockAttemptScript[]) => `export default {
  name: "crash",
  steps: [
    {
      id: "implement",
      agent: { adapter: "mock", options: { attempts: ${JSON.stringify(attempts)} } },
      verification: { command: "node verify.mjs" },
    },
  ],
};
`;

/** The events of a run's ledger that are about the attempt. */
const eventsOf = (repo: string, runId: string, attemptId: string) =>
  ledgerLines(repo, runId).filter((event) => event.attemptId === attemptId);

const countOf = (events: Record<string, unknown>[], type: string) => events.filter((event) => event.type === type).length;

/** Waits until the run's ledger holds an event of `type`, and returns it. */
const untilRecorded = (repo: string, runId: string, type: string) =>
  until(() => ledgerLines(repo, runId).find((event) => event.type === type), `the run to record ${type}`);

describe("ahp recover, after the runtime was killed", () => {
  it("before it spawned the agent: the attempt is never dispatched again, and abort ends the run", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflowFile([{ hangBeforeSpawn: true }, hello]) });
    const runtime = startRun(["workflow.mjs"], repo);
    try {
      const runId = await runtime.runId();
      const { attemptId } = (await untilRecorded(repo, runId, "attempt_dispatching")) as { attemptId: string };
      await runtime.kill();

      const recover = ahp(["recover", runId], repo);

      expect(recover.stderr).toBe("");
      expect(recover.code).toBe(3);
      expect(recover.stdout).toContain(`run ${runId}: resumed by a new process, which took over the stale lock of PID ${runtime.pid}`);
      expect(recover.stdout).toContain(`attempt ${attemptId} [mock] unknown (no_terminal_record)`);
      expect(recover.stdout).toContain("tool-call log: none, the attempt's adapter keeps none");
      expect(recover.stdout).toContain("Host and external effects are undetermined");
      expect(recover.stdout).toContain("Whether the agent's process started is not known.");
      expect(recover.stdout).toContain(`run ${runId}: needs recovery`);
      expect(recover.stdout).toContain(`\`ahp recover ${attemptId} --policy adopt\``);
      expect(countOf(eventsOf(repo, runId, attemptId), "attempt_dispatching")).toBe(1);
      expect(countOf(eventsOf(repo, runId, attemptId), "attempt_running")).toBe(0);

      const abort = ahp(["recover", attemptId, "--policy", "abort"], repo);

      expect(abort.code).toBe(1);
      expect(abort.stdout).toContain(`step implement: recovery of attempt ${attemptId}: abort (the step ends), decided by `);
      expect(abort.stdout).toContain("step implement: failed (unknown) [mock]");
      expect(abort.stdout).toContain(`run ${runId}: failed [mock]`);
      expect(countOf(ledgerLines(repo, runId), "attempt_created")).toBe(1);
    } finally {
      runtime.child.kill("SIGKILL");
    }
  });

  it("mid-attempt: the report shows what the attempt left, and adopt verifies its workspace as the result", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflowFile([{ ...hello, hang: true }]) });
    const runtime = startRun(["workflow.mjs"], repo);
    let agentPid: number | undefined;
    try {
      const runId = await runtime.runId();
      const running = (await untilRecorded(repo, runId, "attempt_running")) as { attemptId: string; pid: number };
      agentPid = running.pid;
      const { attemptId } = running;
      const { workspace } = ledgerLines(repo, runId).find((event) => event.type === "attempt_created") as { workspace: string };
      await until(() => existsSync(join(workspace, "greeting.txt")) || undefined, "the agent to write its edit");
      await runtime.kill();
      // What an agent's push to origin would leave behind in the shared repository.
      const head = git(repo, "rev-parse", "HEAD");
      git(repo, "update-ref", "refs/remotes/origin/main", head);

      const inspect = ahp(["inspect", runId], repo);
      expect(inspect.stdout).toContain(`\`ahp recover ${runId}\` takes it over, examines the run and resumes it`);

      const recover = ahp(["recover", runId], repo);

      expect(recover.code).toBe(3);
      expect(recover.stdout).toContain(`attempt ${attemptId} [mock] unknown (no_terminal_record): the runtime stopped while the attempt was running (PID ${agentPid})`);
      expect(recover.stdout).toMatch(/\| \d+ \S+ attempt_running/);
      expect(recover.stdout).toContain(`workspace ${workspace}: 1 changed against the step's base commit`);
      expect(recover.stdout).toContain("| added greeting.txt");
      expect(recover.stdout).toContain(`| refs/remotes/origin/main: (none) -> ${head.slice(0, 12)}`);
      expect(recover.stdout).toContain(`The agent's process (PID ${agentPid} when it was recorded) may still be running.`);
      const awaiting = ahp(["inspect", runId], repo);
      expect(awaiting.stdout).toContain(`run ${runId}: needs_recovery [mock]`);
      expect(awaiting.stdout).toContain(`recovery: attempt ${attemptId} awaits a decision`);
      expect(awaiting.stdout).toContain("| added greeting.txt");

      const adopt = ahp(["recover", attemptId, "--policy", "adopt"], repo);

      expect(adopt.stderr).toBe("");
      expect(adopt.code).toBe(0);
      expect(adopt.stdout).toContain(`recovery of attempt ${attemptId}: adopt (its workspace is verified as its result), decided by `);
      expect(adopt.stdout).toContain("step implement: verification pass [mock]");
      expect(adopt.stdout).toContain(`run ${runId}: succeeded [mock]`);
      expect(countOf(eventsOf(repo, runId, attemptId), "attempt_dispatching")).toBe(1);
    } finally {
      runtime.child.kill("SIGKILL");
      // The hanging agent outlives the killed runtime; on Windows its working directory cannot be removed while it runs.
      if (agentPid !== undefined && isRunning(agentPid)) {
        process.kill(agentPid, "SIGKILL");
        await untilGone(agentPid, "the hanging agent to exit");
      }
    }
  });
});

describe("ahp run and ahp recover", () => {
  it("ahp run stops at needs_recovery, says how to decide, and exits 3", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflowFile([{ ...hello, loseContact: true }]) });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.code).toBe(3);
    expect(run.stdout).toMatch(/unknown \(lost_contact\): the adapter lost track of the agent: mock adapter lost contact/);
    expect(run.stdout).toMatch(/needs recovery\n {2}attempt att_\w+ awaits a decision: `ahp recover att_\w+ --policy adopt`/);
  });

  it.each([
    { args: ["recover", "att_0123"], code: 2, says: "recover att_0123 needs --policy adopt or --policy abort" },
    { args: ["recover", "att_0123", "--policy", "discard_and_retry"], code: 2, says: "`discard_and_retry` is deferred past release 1" },
    { args: ["recover", "att_0123", "--policy", "retry"], code: 2, says: "--policy must be adopt or abort, not retry" },
    { args: ["recover", "run_0123", "--policy", "adopt"], code: 2, says: "--policy decides an attempt" },
    { args: ["recover", "nothing"], code: 2, says: "not a run ID or an attempt ID: nothing" },
  ])("ahp $args.0 $args.1 refuses: $says", async ({ args, code, says }) => {
    const { repo } = await finishedRun();

    const result = ahp(args, repo);

    expect(result.code).toBe(code);
    expect(result.stderr).toContain(says);
  });

  it("ahp recover refuses an attempt that is not awaiting recovery and exits 1", async () => {
    const { repo, state } = await finishedRun();
    const attemptId = state.steps[0]!.attempts[0]!.id;

    const result = ahp(["recover", attemptId, "--policy", "adopt"], repo);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`attempt ${attemptId} is not awaiting recovery: it exited (ok)`);
  });

  it("ahp recover says a run that ended has nothing to recover", async () => {
    const { repo, runId } = await finishedRun();

    const result = ahp(["recover", runId], repo);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`run ${runId}: already ended (succeeded) [mock]; nothing to recover`);
  });
});
