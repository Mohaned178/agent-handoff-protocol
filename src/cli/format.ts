import type {
  AttemptView,
  ChangedPath,
  EvidenceItem,
  HandoffView,
  LedgerEvent,
  RunView,
  StepView,
  VerificationView,
} from "../protocol/index.ts";
import { findAttempt, findHandoff, findVerification } from "../sdk/index.ts";

export const MOCK_NOTE = "note: this run used the mock adapter; its results are labelled [mock] and are not evidence.";

/** A verification with no command checks only that the output is complete (glossary: structural verification). */
const STRUCTURAL_NOTE = "checks only that the required output fields are present, not the quality of the work";

const mockTag = (isMock: boolean) => (isMock ? " [mock]" : "");
const short = (commit: string) => commit.slice(0, 12);

function stepOfAttempt(state: Readonly<RunView>, attemptId: string): { step: StepView; attempt: AttemptView } {
  const found = findAttempt(state, attemptId);
  if (!found) throw new Error(`unknown attempt ${attemptId}`);
  return found;
}

function stepOfVerification(state: Readonly<RunView>, verificationId: string): StepView {
  const found = findVerification(state, verificationId);
  if (!found) throw new Error(`unknown verification ${verificationId}`);
  return found.step;
}

function stepOfHandoff(state: Readonly<RunView>, handoffId: string, revision: number): StepView {
  const found = findHandoff(state, handoffId, revision);
  if (!found) throw new Error(`unknown handoff ${handoffId} revision ${revision}`);
  return found.step;
}

const describeRevision = (handoffId: string, revision: number) => `${handoffId} revision ${revision}`;

/** One handoff revision in full: its state, why it was rejected if it was, and the whole document as issued. */
function describeHandoff(view: HandoffView): string[] {
  return [
    `  handoff ${describeRevision(view.handoffId, view.revision)}: ${view.state}`,
    ...(view.rejection ?? []).map((reason) => `    rejected (${reason.code}) at ${reason.pointer || "/"}: ${reason.message}`),
    ...JSON.stringify(view.handoff, null, 2)
      .split("\n")
      .map((line) => `    ${line}`),
  ];
}

function describeStep(step: StepView): string {
  return `${step.state}${step.failureClass ? ` (${step.failureClass})` : ""}`;
}

function describeExit({ exitCode, signal }: { exitCode: number | null; signal: string | null }): string {
  return exitCode !== null ? `exit code ${exitCode}` : `signal ${signal}`;
}

function describeEvidence(item: EvidenceItem): string[] {
  switch (item.kind) {
    case "test_output":
      return [
        `      evidence: test output (${describeExit(item)})${item.truncated ? ", tail only" : ""}`,
        ...item.output.trimEnd().split(/\r?\n/).map((line) => `        | ${line}`),
      ];
    case "required_output_fields":
      return [
        `      evidence: required output fields (${item.required.join(", ")}): ${
          item.missing.length === 0 ? "all present" : `missing ${item.missing.join(", ")}`
        }`,
      ];
    case "diff_scope":
      return [
        `      evidence: diff scope (${item.changed.length === 0 ? "no changes" : `${item.changed.length} changed${item.truncated ? ", first only" : ""}`})`,
        ...item.changed.map((change) => `        | ${describeChange(change)}`),
      ];
    case "validator_error":
      return [
        `      evidence: the validator could not run (${item.stage}); this says nothing about the attempt`,
        ...item.message.split(/\r?\n/).map((line) => `        | ${line}`),
      ];
    case "protected_paths":
      return [
        `      evidence: protected paths (${item.protected.join(", ")}): ${
          item.violations.length === 0 ? "none changed" : "changed, the verification command was not run"
        }`,
        ...item.violations.map((change) => `        | ${describeChange(change)}`),
        ...(item.truncated ? ["        | ..."] : []),
      ];
  }
}

const describeChange = ({ path, change }: ChangedPath) => `${change} ${path}`;

function describeAttempt(attempt: AttemptView): string {
  if (attempt.state !== "exited") return attempt.state;
  const stopped = attempt.stopReason ? `, stop reason ${attempt.stopReason}` : "";
  return `exited ${attempt.outcome} (${describeExit(attempt)}${stopped})`;
}

/** Why a failed step stopped, as one line: the failure class says what happened, this says what was done about it. */
function describeStop(step: StepView): string | null {
  const last = step.attempts.at(-1);
  switch (step.failureClass) {
    case "config_auth":
      return `not retried: ${last?.error?.message ?? "the coding agent's login or configuration is wrong"}. This needs your attention: fix the tool's login or configuration, then run again.`;
    case "inconclusive":
      return "escalated: the validator could not run twice, which says nothing about the work. Fix the validator or its environment, then run again.";
    case "agent_error":
    case "verification_failed":
    case "transient":
      return `retry budget spent${step.retryUsage.rerouted ? ", after a reroute" : ""}`;
    case "unknown":
      return "not retried: the attempt's outcome is unknown";
    default:
      return null;
  }
}

function describeVerification(label: string, verification: VerificationView, note = ""): string[] {
  const lines = [
    `    ${label}: ${verification.state}${note}`,
    verification.command === null
      ? `      structural verification: ${STRUCTURAL_NOTE}`
      : `      command: ${verification.command}`,
  ];
  if (verification.worktree !== null) lines.push(`      worktree: ${verification.worktree}`);
  for (const item of verification.evidence) lines.push(...describeEvidence(item));
  return lines;
}

/** One progress line for a recorded event, given the state derived after it. */
export function formatEvent(event: LedgerEvent, state: Readonly<RunView>): string {
  const attemptLine = (attemptId: string, text: string) => {
    const { step, attempt } = stepOfAttempt(state, attemptId);
    return `step ${step.id}: attempt ${attempt.id}${mockTag(attempt.mock)} ${text}`;
  };
  switch (event.type) {
    case "run_created":
      return `run ${state.runId}: created (workflow "${state.workflowName}", base ${short(state.baseCommit)})`;
    case "run_started":
      return `run ${state.runId}: running`;
    case "step_ready":
      return `step ${event.stepId}: ready`;
    case "handoff_issued":
      return `step ${event.handoff.to.stepId}: handoff ${describeRevision(event.handoff.handoffId, event.handoff.revision)} issued`;
    case "handoff_accepted":
      return `step ${stepOfHandoff(state, event.handoffId, event.revision).id}: handoff ${describeRevision(event.handoffId, event.revision)} accepted`;
    case "handoff_rejected": {
      const reasons = event.reasons.map((reason) => reason.code).join(", ");
      return `step ${stepOfHandoff(state, event.handoffId, event.revision).id}: handoff ${describeRevision(event.handoffId, event.revision)} rejected (${reasons})`;
    }
    case "attempt_created":
      return attemptLine(event.attemptId, `created (workspace ${event.workspace})`);
    case "attempt_dispatching":
      return attemptLine(event.attemptId, "dispatching");
    case "attempt_running":
      return attemptLine(event.attemptId, `running (pid ${event.pid})`);
    case "attempt_exited":
      return attemptLine(event.attemptId, describeAttempt(stepOfAttempt(state, event.attemptId).attempt));
    case "workspace_snapshot_committed":
      return attemptLine(event.attemptId, `snapshot ${short(event.commit)}`);
    case "verification_started": {
      const { step, attempt } = stepOfAttempt(state, event.attemptId);
      // A command with no worktree was not run: a protected path changed, or the check could not be made.
      const kind =
        event.command === null
          ? "structural verification"
          : event.worktree === null
            ? "verification (command not run)"
            : attempt.earlierVerifications.length > 0
              ? "verifying again"
              : "verifying";
      return `step ${step.id}: ${kind}${mockTag(step.mock)}: ${event.command ?? STRUCTURAL_NOTE}`;
    }
    case "verification_verdict": {
      const step = stepOfVerification(state, event.verificationId);
      return `step ${step.id}: verification ${event.verdict}${mockTag(step.mock)}`;
    }
    case "attempt_failed":
      return attemptLine(event.attemptId, `failed: ${event.failureClass}`);
    case "retry_scheduled": {
      const { stepId, attemptId, failureClass, change, delayMs } = event;
      const what = {
        none: "a new attempt under the same handoff revision",
        evidence: "a new handoff revision carries the evidence",
        reroute: "the alternative agent takes over under a new handoff revision",
      }[change];
      // Printed when the retry is scheduled, before the wait is taken.
      const wait = delayMs > 0 ? `, waiting ${delayMs} ms first` : "";
      return `step ${stepId}: ${change === "reroute" ? "rerouting" : "retrying"} after attempt ${attemptId} (${failureClass}): ${what}${wait}`;
    }
    case "step_terminal": {
      const step = state.steps.find((s) => s.id === event.stepId)!;
      const line = `step ${step.id}: ${describeStep(step)}${mockTag(step.mock)}`;
      const stop = step.state === "failed" ? describeStop(step) : null;
      return stop ? `${line}\n  ${stop}` : line;
    }
    case "run_terminal":
      return `run ${state.runId}: ${state.state}${mockTag(state.mock)}`;
  }
}

/** A human-readable account of a run's derived state. */
export function formatRun(state: Readonly<RunView>): string {
  const lines = [
    `run ${state.runId}: ${state.state}${mockTag(state.mock)}`,
    `  workflow: ${state.workflowName}`,
    `  repo: ${state.repo}`,
    `  base commit: ${state.baseCommit}`,
    `  protocol: ${state.protocolVersion}`,
    `  created: ${state.createdAt}`,
    `  ended: ${state.endedAt ?? "-"}`,
  ];
  if (state.mock) lines.push(`  ${MOCK_NOTE}`);
  for (const step of state.steps) {
    lines.push("", `step ${step.id}: ${describeStep(step)}${mockTag(step.mock)}`);
    const { retries, transientRetries, transientWaitMs, rerouted } = step.retryUsage;
    if (retries + transientRetries > 0 || rerouted) {
      lines.push(
        `  retries used: ${retries} (agent error and failed verification), ${transientRetries} (transient, ${transientWaitMs} ms waited), rerouted: ${rerouted ? "yes" : "no"}`,
      );
    }
    const stop = step.state === "failed" ? describeStop(step) : null;
    if (stop) lines.push(`  ${stop}`);
    for (const handoff of step.handoffs) lines.push(...describeHandoff(handoff));
    for (const attempt of step.attempts) {
      const reported = Object.keys(attempt.reportedOutput);
      lines.push(
        `  attempt ${attempt.id}${mockTag(attempt.mock)}: ${describeAttempt(attempt)}`,
        `    handoff: ${describeRevision(attempt.handoff.id, attempt.handoff.revision)}`,
        `    adapter: ${attempt.adapter}`,
        `    requested model: ${attempt.requestedModel ?? "(none)"}`,
        `    reported model: ${attempt.reportedModel}`,
        `    pid: ${attempt.pid ?? "-"}`,
        `    workspace: ${attempt.workspace}`,
        `    reported output fields: ${reported.length > 0 ? reported.join(", ") : "(none)"}`,
        `    snapshot: ${attempt.snapshot ? `${attempt.snapshot.commit} (${attempt.snapshot.ref})` : "-"}`,
      );
      if (attempt.failureClass) lines.push(`    failure class: ${attempt.failureClass}`);
      if (attempt.stopReason) lines.push(`    stop reason: ${attempt.stopReason}`);
      if (attempt.error) lines.push(`    error (${attempt.error.kind}): ${attempt.error.message}`);
      for (const earlier of attempt.earlierVerifications) {
        lines.push(...describeVerification("earlier verification", earlier, " (the validator could not run; verified again)"));
      }
      if (!attempt.verification) {
        lines.push("    verification: not run");
        continue;
      }
      lines.push(...describeVerification("verification", attempt.verification));
    }
  }
  return lines.join("\n");
}
