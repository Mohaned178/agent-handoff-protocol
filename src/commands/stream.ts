// What a plain command prints while a run goes and when it stops: a line for each step that ends, for each retry, send-back,
// wait for a person and cancel, then the receipt (`receiptOf`), one `next:` line and, on the mock, the note that it is not
// evidence. No colour, no animation, nothing rewritten in place: it reads the same in a log, a pipe or a CI job. The symbols
// are the app's (✓ ✗ ↻ !). Everything else a run holds, every attempt, handoff and verification, is `ahp inspect`'s.

import type { LedgerEvent, RunView } from "../protocol/index.ts";
import { MOCK_RECEIPT_LINE, nextStepOf } from "./receipt.ts";
import { findHandoff } from "../sdk/index.ts";
import { formatBriefReceipt } from "./receipt-text.ts";
import {
  describeApprovalChoices,
  describeAwaited,
  describeChangedPaths,
  describeDecision,
  describeObserved,
  describeReport,
  describeResumption,
  describeRevision,
  describeStep,
  describeStop,
  describeTruncation,
  mockTag,
  short,
  stepOfAttempt,
} from "./inspect-text.ts";

/** Where the lines go. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** A step's own line: its symbol, its ID and what happened. */
const stepLine = (symbol: string, stepId: string, text: string) => `${symbol} ${stepId}  ${text}`;

/** The state as a run's line says it: the two that wait for a person in words. */
function stateWords(state: Readonly<RunView>): string {
  switch (state.state) {
    case "waiting_approval":
      return "waiting for approval";
    case "needs_recovery":
      return "needs recovery";
    default:
      return state.state;
  }
}

/** A step that ended, in one line (and the reason it stopped, when it failed). Null where another line already said it. */
function stepEnded(stepId: string, state: Readonly<RunView>): string | null {
  const step = state.steps.find((candidate) => candidate.id === stepId)!;
  const tag = mockTag(step.mock);
  if (step.kind === "external_action" && step.state === "succeeded" && step.action) {
    const { performed, checks } = step.action;
    const done = performed ? `done: ${describeObserved(performed.observed)}` : `already done: ${checks.at(-1) ? describeObserved(checks.at(-1)!.observed) : "on the remote"}; it is not done again`;
    return stepLine("✓", step.id, done);
  }
  // The gate's decision was said when it was made.
  if (step.kind === "approval_gate" && step.state === "succeeded") return null;
  const stop = step.state === "failed" ? describeStop(step, state) : null;
  const line = stepLine(step.state === "succeeded" ? "✓" : "✗", step.id, `${describeStep(step)}${tag}`);
  return stop ? `${line}\n  ${stop.split("\n").join("\n  ")}` : line;
}

/** The line a recorded event gets, given the state derived after it; null for an event that is not worth one. */
export function lineOf(event: LedgerEvent, state: Readonly<RunView>): string | null {
  switch (event.type) {
    case "run_created":
      return `run ${state.runId}: created · ${state.workflowName}`;
    case "run_resumed":
      return `run ${state.runId}: ${describeResumption(event.takenOverFrom)}`;
    case "ledger_truncated":
      return `run ${state.runId}: ${describeTruncation(event.droppedBytes)}`;
    case "handoff_rejected": {
      const step = findHandoff(state, event.handoffId, event.revision)?.step;
      return stepLine("!", step?.id ?? "?", `handoff ${describeRevision(event.handoffId, event.revision)} rejected (${event.reasons.map((reason) => reason.code).join(", ")})`);
    }
    case "attempt_unknown": {
      const { step, attempt } = stepOfAttempt(state, event.attemptId);
      return stepLine("!", step.id, `attempt ${attempt.id}${mockTag(attempt.mock)} unknown (${event.reason}): ${event.detail}; it is never retried automatically`);
    }
    case "recovery_report_written": {
      const { step } = stepOfAttempt(state, event.attemptId);
      return [stepLine("!", step.id, `recovery report of attempt ${event.attemptId}:`), ...describeReport(event.report, "  ")].join("\n");
    }
    case "recovery_awaited":
      return `! ${describeAwaited(event.attemptId)}`;
    case "recovery_decided": {
      const { step } = stepOfAttempt(state, event.attemptId);
      return stepLine("↻", step.id, `recovery of attempt ${event.attemptId}: ${describeDecision(event)}`);
    }
    case "retry_scheduled": {
      const { stepId, attemptId, failureClass, change, delayMs } = event;
      const what = {
        none: "a new attempt under the same handoff revision",
        evidence: "a new handoff revision carries the evidence",
        reroute: "the alternative agent takes over under a new handoff revision",
      }[change];
      const wait = delayMs > 0 ? `, waiting ${delayMs} ms first` : "";
      return stepLine("↻", stepId, `${change === "reroute" ? "rerouting" : "retrying"} after attempt ${attemptId} (${failureClass}): ${what}${wait}`);
    }
    case "step_sent_back": {
      const { step, attempt } = stepOfAttempt(state, event.attemptId);
      const findings = attempt.sentBack?.kind === "review" ? attempt.sentBack.findings : [];
      return [
        stepLine("↻", event.reviewStepId, `changes requested: step ${step.id} is sent back (retry ${step.retryUsage.retries} spent), and a new handoff revision carries the findings`),
        ...findings.map((finding) => `  | ${finding}`),
      ].join("\n");
    }
    case "approval_requested": {
      const { step } = stepOfAttempt(state, event.attemptId);
      return stepLine("!", event.stepId, `waits for a person: step ${step.id}'s attempt ${event.attemptId} passed verification (snapshot ${short(event.commit)}; ${describeChangedPaths(event.changed, event.truncated)} against the run's base commit)`);
    }
    case "approval_decided":
      return stepLine(event.decision === "approved" ? "✓" : "↻", event.stepId, `${event.decision} by ${event.user}${event.reason === null ? "" : `: ${event.reason}`}`);
    case "approval_sent_back": {
      const { step } = stepOfAttempt(state, event.attemptId);
      return stepLine("↻", event.gateStepId, `rejected: step ${step.id} is sent back (retry ${step.retryUsage.retries} spent), and a new handoff revision carries the reason`);
    }
    case "step_terminal":
      return stepEnded(event.stepId, state);
    case "run_cancel_requested":
      return `! run ${state.runId}: cancelling: no further agent is dispatched`;
    case "attempt_cancelling": {
      const { step, attempt } = stepOfAttempt(state, event.attemptId);
      return stepLine("!", step.id, `cancelling: stopping the agent (PID ${attempt.pid}) and every process it started`);
    }
    default:
      return null;
  }
}

/** The line the exit code is read from, the receipt, the one command to run next, and the mock note. */
export function endOf(state: Readonly<RunView>): string {
  const next = state.state === "waiting_approval" ? waitingNext(state) : nextStepOf(state);
  return [
    `run ${state.runId}: ${stateWords(state)}${mockTag(state.mock)}`,
    ...formatBriefReceipt(state),
    ...(next ? [`next: ${next}`] : []),
    ...(state.mock ? [MOCK_RECEIPT_LINE] : []),
  ].join("\n");
}

/** What a person can do at the gate a run waits at: `nextStepOf` says nothing of a wait, which the app decides in place. */
function waitingNext(state: Readonly<RunView>): string | null {
  const gate = state.steps.find((step) => step.state === "waiting_approval" && !step.approvals.at(-1)?.decision);
  return gate ? describeApprovalChoices(state.runId, gate.id) : null;
}

/**
 * The exit code for a run in `state`: 0 succeeded, 3 stopped for a recovery decision, 4 stopped at an approval gate, 130
 * cancelled, 1 anything else.
 */
export function exitCodeOf(state: Readonly<RunView>): number {
  switch (state.state) {
    case "succeeded":
      return 0;
    case "needs_recovery":
      return 3;
    case "waiting_approval":
      return 4;
    case "cancelled":
      // What a shell reports for a command Ctrl+C stopped: 128 + SIGINT.
      return 130;
    default:
      return 1;
  }
}

export interface Following {
  onEvent: (event: LedgerEvent, state: Readonly<RunView>) => void;
  /** Aborted on Ctrl+C (SIGINT) or SIGTERM: the run is cancelled. */
  signal: AbortSignal;
}

/**
 * Makes Ctrl+C (SIGINT) and SIGTERM abort the returned signal instead of killing ahp, so what is running can be stopped and
 * the cancel recorded; the first says so on stderr, a later one only that it is under way. `release` gives the signals back.
 */
export function cancelOnInterrupt(io: Io, what: string, whileWaiting: string): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) {
      io.stderr(`ahp: still cancelling: ${whileWaiting}`);
      return;
    }
    io.stderr(`ahp: cancelling ${what} (Ctrl+C)`);
    controller.abort();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  return {
    signal: controller.signal,
    release: () => {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    },
  };
}

/**
 * Prints a line for each event `execute` records, and the run's end (also when `execute` throws partway) once it stops.
 * Ctrl+C meanwhile cancels the run instead of killing ahp.
 */
export async function followRun<R>(io: Io, execute: (following: Following) => Promise<R>): Promise<R> {
  let last: Readonly<RunView> | null = null;
  const interrupt = cancelOnInterrupt(io, "the run", "waiting until the agent and every process it started are seen gone");
  try {
    return await execute({
      signal: interrupt.signal,
      onEvent: (event, current) => {
        last = current;
        const line = lineOf(event, current);
        if (line !== null) io.stdout(line);
      },
    });
  } finally {
    interrupt.release();
    if (last) io.stdout(endOf(last));
  }
}
