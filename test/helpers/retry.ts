import { defineWorkflow, mock } from "../../src/index.ts";
import type { MockAttemptScript, RunView, StepDefinition } from "../../src/index.ts";

/** A one-step workflow whose mock agent runs `attempts` in turn and whose verification wants "hello" in greeting.txt. */
export function retryWorkflow(attempts: MockAttemptScript[], step: Partial<StepDefinition> = {}) {
  return defineWorkflow({
    name: "retry",
    steps: [{ id: "implement", agent: mock({ attempts }), verification: { command: "node verify.mjs" }, ...step }],
  });
}

/** An attempt that does the work: it passes `VERIFY_GREETING`. */
export const hello: MockAttemptScript = { edits: [{ path: "greeting.txt", content: "hello\n" }] };
/** An attempt whose work fails `VERIFY_GREETING`. */
export const goodbye: MockAttemptScript = { edits: [{ path: "greeting.txt", content: "goodbye\n" }] };
/** An attempt whose agent exits with an error. */
export const failing: MockAttemptScript = { exitCode: 3 };

/** The only step of a `retryWorkflow` run. */
export const implementOf = (state: RunView) => state.steps[0]!;
