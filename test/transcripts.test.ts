import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow, mock, runWorkflow } from "../src/index.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

afterEach(removeTempRepos);

/** Where the runtime keeps an attempt's transcript: beside the run's ledger, outside every working tree. */
const transcriptOf = (repo: string, runId: string, attemptId: string, which: "in" | "out") =>
  join(repo, ".git", "ahp", "runs", runId, "transcripts", `${attemptId}.${which}.txt`);

describe("raw transcripts", () => {
  it("keeps, for every attempt of a run, what its agent process was sent and what it printed, each attempt in its own files", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const workflow = defineWorkflow({
      name: "greeting",
      steps: [
        {
          id: "implement",
          agent: mock({
            attempts: [
              { edits: [{ path: "greeting.txt", content: "wrong\n" }], outputFields: { summary: "first try" } },
              { edits: [{ path: "greeting.txt", content: "hello\n" }], outputFields: { summary: "second try" } },
            ],
          }),
          verification: { command: "node verify.mjs", requiredOutputFields: ["summary"] },
          retry: { budget: 1 },
        },
      ],
    });

    const { runId, state } = await runWorkflow(workflow, { repo });

    expect(state.state).toBe("succeeded");
    const attempts = state.steps[0]!.attempts;
    expect(attempts).toHaveLength(2);
    const [first, second] = attempts.map((attempt) => ({
      // The mock agent is sent its script as JSON, and prints its report as JSON.
      sent: JSON.parse(readFileSync(transcriptOf(repo, runId, attempt.id, "in"), "utf8")),
      printed: JSON.parse(readFileSync(transcriptOf(repo, runId, attempt.id, "out"), "utf8")),
    }));
    expect(first!.sent.edits[0].content).toBe("wrong\n");
    expect(first!.printed.outputFields).toEqual({ summary: "first try" });
    expect(second!.sent.edits[0].content).toBe("hello\n");
    expect(second!.printed.outputFields).toEqual({ summary: "second try" });
  });

  it("leaves nothing of the transcript in the attempt's workspace or its snapshot", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const workflow = defineWorkflow({
      name: "greeting",
      steps: [{ id: "implement", agent: mock({ attempts: [{ edits: [{ path: "greeting.txt", content: "hello\n" }] }] }), verification: { command: "node verify.mjs" }, retry: { budget: 0 } }],
    });

    const { runId, state } = await runWorkflow(workflow, { repo });

    const attempt = state.steps[0]!.attempts[0]!;
    expect(existsSync(transcriptOf(repo, runId, attempt.id, "out"))).toBe(true);
    expect(existsSync(join(attempt.workspace, "transcripts"))).toBe(false);
  });
});
