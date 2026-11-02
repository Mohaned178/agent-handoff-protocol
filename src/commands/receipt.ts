// The receipt of a run, as data: what AHP's checks caught that an agent alone would not have said, read from the run's
// state and nothing else. An agent's report is a claim, so the receipt counts the times an agent "reported done", never
// that work "was done"; and it holds only what the ledger records: no "would have", no estimate of time or money saved.
// The old terminal layer (`src/cli/receipt.ts`) and the app's run screen both render it.

import { reviewVerdictOf, THIS_REPOSITORY, type AttemptView, type ChangedPath, type EvidenceItem, type FailureClass, type RunState, type RunView, type StepView } from "../protocol/index.ts";
import { TOOLS } from "../doctor/tools.ts";
import { summarizeUsage, type UsageSummary } from "../runtime/usage.ts";

/** What the receipt says on a run that used the mock adapter. */
export const MOCK_RECEIPT_LINE = "scripted mock agents: their results are not evidence";

const changesOf = (changed: readonly ChangedPath[]) => changed.map(({ change, path }) => `${change} ${path}`).join(", ");

/** The line of a failed check's output that says what failed: the first that looks like a failure, else the last. */
export function failingLineOf(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // A command that is not there says so first (cmd.exe over two lines: the first names it).
  const missing = lines.find((line) => /not recognized as|command not found|not found|no such file/i.test(line));
  return missing ?? lines.find((line) => /fail|error|assert|wrong|missing|expected|not ok|✗|×/i.test(line)) ?? lines.at(-1) ?? "(no output)";
}

/** Why an attempt's verification failed, in one line; a refusal starts "refused: ". */
export function whyFailed(evidence: readonly EvidenceItem[]): string {
  for (const item of evidence) {
    if (item.kind === "protected_paths" && item.violations.length > 0) return `refused: it changed a protected path (${changesOf(item.violations)}), so its check was not run`;
    if (item.kind === "forbidden_external_action_detected") {
      return `refused: a shared ref moved while it ran (${item.changed.map((change) => change.name).join(", ")}); only AHP may move one, so its check was not run (the agent, or someone working in this repository meanwhile, moved it)`;
    }
  }
  for (const item of evidence) {
    if (item.kind === "test_output" && item.exitCode !== 0) return failingLineOf(item.output);
    if (item.kind === "required_output_fields" && item.missing.length > 0) return `it did not report ${item.missing.join(", ")}`;
    if (item.kind === "review_verdict" && item.verdict === null) return `its verdict was not understood (${JSON.stringify(item.reported)})`;
    if (item.kind === "context_over_budget") return `what it hands on came to ${item.bytes} bytes, over its budget of ${item.maxBytes}`;
  }
  return "its verification failed";
}

/** Why an attempt failed, in one line: the tool's error, or what its verification found; null when it did not fail. */
export function failureLineOf(attempt: AttemptView): string | null {
  if (attempt.error) {
    const message = attempt.error.message.split(/\r?\n/)[0]!;
    // A login or configuration problem is not retried: the fix is the person's, so it is named.
    const tool = attempt.error.kind === "config_auth" ? TOOLS.find((candidate) => candidate.adapter === attempt.adapter) : undefined;
    return tool ? `${message} · to log in: ${tool.logIn}` : message;
  }
  if (attempt.verification?.state === "fail") return whyFailed(attempt.verification.evidence);
  return null;
}

/** The check a step ran last, or the one its workflow gave it when none ran (the step ended before its check); null for none. */
export const checkCommandOf = (step: StepView): string | null =>
  step.attempts.map((attempt) => attempt.verification?.command ?? null).filter((command) => command !== null).at(-1) ?? step.check ?? null;

/** Whether a step's check ever ran: a step can fail before it does (a login, a usage limit, an agent error). */
const checkRan = (step: StepView) => step.attempts.some((attempt) => attempt.verification?.command != null);

/** An attempt whose agent reported done and whose check failed. */
export interface ReportedDone {
  attempt: number;
  /** The failing line, or why it was refused. */
  why: string;
  /** True when the check was not run at all: a protected path changed, or a shared ref moved. */
  refused: boolean;
}

/** A step's result sent back to it, by a review or by a person at a gate, and what became of the revision. */
export type ReceiptSendBack = {
  /** The attempt whose result was sent back. */
  attempt: number;
  /** What the next review, or the gate's next decision, made of the revision. */
  after: string;
  approvedAfter: boolean;
} & ({ kind: "review"; by: string; findings: string[] } | { kind: "approval"; by: string; user: string; reason: string });

export interface ReceiptStep {
  stepId: string;
  /** The check it ran last, or its workflow's when none ran; null for a step without one. */
  command: string | null;
  /**
   * What its check decided, for a step that ended with one: `verified` (it passed in a clean copy), `not_verified` (it
   * failed), `ended_before_check` (the step failed before the check ran); null otherwise.
   */
  verdict: "verified" | "not_verified" | "ended_before_check" | null;
  failureClass: FailureClass | null;
  /** The times its agent reported done and the check said otherwise, oldest first. */
  reportedDone: ReportedDone[];
  /** Whether its check passed after those. */
  passedAfter: boolean;
  sendBacks: ReceiptSendBack[];
  /** Handoff revisions its adapter refused, one per reason. */
  handoffRefusals: { revision: number; message: string }[];
}

export interface Receipt {
  runId: string;
  state: RunState;
  /** True when any attempt ran on the mock adapter: nothing in the receipt is evidence. */
  mock: boolean;
  /** False when no agent step has a check command: nothing was verified. */
  checked: boolean;
  /** One per agent or review step, in workflow order. */
  steps: ReceiptStep[];
  /** Per adapter, as each tool reported it: never summed across adapters, nothing estimated. */
  usage: UsageSummary[];
  /** The one command to run next, or null when there is nothing to do. */
  next: string | null;
}

/** What became of a revision a review sent back: what the review's next attempt concluded, if it ran. */
function afterReview(review: StepView | undefined, sentBackBy: string): { after: string; approved: boolean } {
  const index = review?.attempts.findIndex((attempt) => attempt.id === sentBackBy) ?? -1;
  const next: AttemptView | undefined = index < 0 ? undefined : review!.attempts.slice(index + 1).find((attempt) => attempt.state === "exited");
  if (!next) return { after: "the revision has not been reviewed again", approved: false };
  const verdict = next.verification?.state === "pass" ? reviewVerdictOf(next.reportedOutput) : null;
  if (verdict === "approved") return { after: "the next review approved the revision", approved: true };
  if (verdict === "changes_requested") return { after: "the next review asked for changes again", approved: false };
  return { after: "the next review did not reach a verdict", approved: false };
}

/** What a gate's next decision on the revision a person rejected was. */
function afterRejection(gate: StepView | undefined, decidedAt: string): { after: string; approved: boolean } {
  const next = gate?.approvals.find((approval) => approval.requestedAt > decidedAt)?.decision ?? null;
  if (next === null) return { after: "the revision has not been decided again", approved: false };
  return next.decision === "approved" ? { after: "the revision was approved at the gate", approved: true } : { after: "the revision was rejected again", approved: false };
}

function sendBacksOf(step: StepView, state: Readonly<RunView>): ReceiptSendBack[] {
  return step.attempts.flatMap((attempt): ReceiptSendBack[] => {
    const sent = attempt.sentBack;
    if (sent === null) return [];
    if (sent.kind === "review") {
      const { after, approved } = afterReview(state.steps.find((candidate) => candidate.id === sent.reviewStepId), sent.reviewAttemptId);
      return [{ kind: "review", attempt: attempt.number, by: sent.reviewStepId, findings: sent.findings, after, approvedAfter: approved }];
    }
    const { after, approved } = afterRejection(state.steps.find((candidate) => candidate.id === sent.gateStepId), sent.decidedAt);
    return [{ kind: "approval", attempt: attempt.number, by: sent.gateStepId, user: sent.user, reason: sent.reason, after, approvedAfter: approved }];
  });
}

function receiptStepOf(step: StepView, state: Readonly<RunView>): ReceiptStep {
  const command = checkCommandOf(step);
  const verdict =
    command === null ? null : step.state === "succeeded" ? "verified" : step.state === "failed" ? (checkRan(step) ? "not_verified" : "ended_before_check") : null;
  const reportedDone = step.attempts
    .filter((attempt) => attempt.verification?.state === "fail")
    .map((attempt) => {
      const why = whyFailed(attempt.verification!.evidence);
      return { attempt: attempt.number, why, refused: why.startsWith("refused: ") };
    });
  return {
    stepId: step.id,
    command,
    verdict,
    failureClass: step.failureClass,
    reportedDone,
    passedAfter: step.attempts.some((attempt) => attempt.verification?.state === "pass"),
    sendBacks: sendBacksOf(step, state),
    handoffRefusals: step.handoffs.flatMap((handoff) => (handoff.rejection ?? []).map((reason) => ({ revision: handoff.revision, message: reason.message }))),
  };
}

/** The one command to run next for a run in `state`, or null when there is nothing to do or it was said already. */
export function nextStepOf(state: Readonly<RunView>): string | null {
  switch (state.state) {
    case "succeeded": {
      const push = state.steps.map((step) => step.action?.target).filter((target) => target?.kind === "push_branch").at(-1);
      if (!push) return null;
      return push.remote === THIS_REPOSITORY ? `git merge ${push.branch}` : `open a pull request from ${push.branch} on ${push.remote}`;
    }
    case "failed":
      return `ahp inspect ${state.runId} shows every attempt and its evidence`;
    case "needs_recovery": {
      const awaiting = state.steps.flatMap((step) => step.attempts).filter((attempt) => attempt.recovery?.awaited && attempt.recovery.decision === null);
      return awaiting.length > 0 ? awaiting.map((attempt) => `ahp recover ${attempt.id} --policy adopt|abort`).join("; ") : `ahp recover ${state.runId}`;
    }
    case "pending":
    case "running":
      return `ahp recover ${state.runId} resumes it`;
    default:
      return null;
  }
}

/** The receipt of a run in `state`, as data. */
export function receiptOf(state: Readonly<RunView>): Receipt {
  const agentSteps = state.steps.filter((step) => step.kind === "agent" || step.kind === "review");
  const steps = agentSteps.map((step) => receiptStepOf(step, state));
  return {
    runId: state.runId,
    state: state.state,
    mock: state.mock,
    checked: steps.some((step) => step.command !== null),
    steps,
    usage: summarizeUsage(state.steps.flatMap((step) => step.attempts)),
    next: nextStepOf(state),
  };
}
