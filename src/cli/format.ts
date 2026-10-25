import type { AttemptView, EvidenceItem, HandoffView, LedgerEvent, RunView, StepView } from "../protocol/index.ts";
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
  }
}

function describeAttempt(attempt: AttemptView): string {
  return attempt.state === "exited" ? `exited ${attempt.outcome} (${describeExit(attempt)})` : attempt.state;
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
      const { step } = stepOfAttempt(state, event.attemptId);
      return `step ${step.id}: ${event.command === null ? "structural verification" : "verifying"}${mockTag(step.mock)}: ${
        event.command ?? STRUCTURAL_NOTE
      }`;
    }
    case "verification_verdict": {
      const step = stepOfVerification(state, event.verificationId);
      return `step ${step.id}: verification ${event.verdict}${mockTag(step.mock)}`;
    }
    case "step_terminal": {
      const step = state.steps.find((s) => s.id === event.stepId)!;
      return `step ${step.id}: ${describeStep(step)}${mockTag(step.mock)}`;
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
      const verification = attempt.verification;
      if (!verification) {
        lines.push("    verification: not run");
        continue;
      }
      lines.push(
        `    verification: ${verification.state}`,
        verification.command === null
          ? `      structural verification: ${STRUCTURAL_NOTE}`
          : `      command: ${verification.command}`,
      );
      if (verification.worktree !== null) lines.push(`      worktree: ${verification.worktree}`);
      for (const item of verification.evidence) lines.push(...describeEvidence(item));
    }
  }
  return lines.join("\n");
}
