import { reviewVerdictOf } from "../protocol/index.ts";
import type {
  AttemptCancel,
  AttemptRecovery,
  AttemptView,
  ChangedPath,
  EvidenceItem,
  HandoffView,
  LedgerEvent,
  RecoveryDecision,
  RecoveryReport,
  RunView,
  StepView,
  VerificationView,
} from "../protocol/index.ts";
import {
  findAttempt,
  findHandoff,
  findVerification,
  type LockOwner,
  type LockState,
  type ResumeResult,
  type RunInspection,
} from "../sdk/index.ts";

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
  if (exitCode !== null) return `exit code ${exitCode}`;
  return signal !== null ? `signal ${signal}` : "no exit status reported";
}

/** How a cancelled attempt's agent was stopped. */
function describeCancel({ via }: AttemptCancel): string {
  switch (via) {
    case "transport":
      return "stopped gracefully by its transport's cancel";
    case "signal":
      return "stopped gracefully by SIGTERM to its process group";
    case "tree_kill":
      return "forced: its process tree was killed";
  }
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
    case "review_verdict":
      return [
        item.verdict === null
          ? `      evidence: review verdict: not understood (reported ${JSON.stringify(item.reported)}; it must be approved or changes_requested)`
          : `      evidence: review verdict: ${item.verdict}`,
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
  const cancel = attempt.cancellation?.result ? `; ${describeCancel(attempt.cancellation.result)}` : "";
  return `exited ${attempt.outcome} (${describeExit(attempt)}${stopped}${cancel})`;
}

/** Why a failed step stopped, as one line: the failure class says what happened, this says what was done about it. */
function describeStop(step: StepView, state: Readonly<RunView>): string | null {
  const last = step.attempts.at(-1);
  // A review that passed verification and asked for changes, with nothing left to send the step before it back with.
  if (last?.verification?.state === "pass" && reviewVerdictOf(last.reportedOutput) === "changes_requested") {
    const before = state.steps[state.steps.indexOf(step) - 1];
    return `changes requested, and the retry budget of step ${before?.id ?? "before it"} is spent, so it cannot be sent back again`;
  }
  if (last?.recovery?.decision?.policy === "adopt") {
    return "not retried: the adopted workspace failed, and the attempt's agent, whose outcome was unknown, may still be running";
  }
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
    case "ref_snapshot_taken":
      return attemptLine(
        event.attemptId,
        `shared refs recorded ${event.phase === "before" ? "before dispatch" : "after exit"} (${quantity(event.refs.length, "ref")})`,
      );
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
    case "attempt_unknown":
      return attemptLine(event.attemptId, `unknown (${event.reason}): ${event.detail}; it is never retried automatically`);
    case "recovery_report_written":
      return [attemptLine(event.attemptId, "recovery report:"), ...describeReport(event.report, "  ")].join("\n");
    case "recovery_awaited":
      return `run ${state.runId}: needs recovery\n  ${describeAwaited(event.attemptId)}`;
    case "recovery_decided": {
      const { step } = stepOfAttempt(state, event.attemptId);
      return `step ${step.id}: recovery of attempt ${event.attemptId}: ${describeDecision(event)}`;
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
    case "step_sent_back": {
      const { step, attempt } = stepOfAttempt(state, event.attemptId);
      return [
        `step ${event.reviewStepId}: changes requested: step ${step.id} is sent back (retry ${step.retryUsage.retries} spent), and a new handoff revision carries the findings`,
        ...(attempt.sentBack?.findings ?? []).map((finding) => `  | ${finding}`),
      ].join("\n");
    }
    case "step_terminal": {
      const step = state.steps.find((s) => s.id === event.stepId)!;
      const line = `step ${step.id}: ${describeStep(step)}${mockTag(step.mock)}`;
      const stop = step.state === "failed" ? describeStop(step, state) : null;
      return stop ? `${line}\n  ${stop}` : line;
    }
    case "run_terminal":
      return `run ${state.runId}: ${state.state}${mockTag(state.mock)}`;
    case "ledger_truncated":
      return `run ${state.runId}: ${describeTruncation(event.droppedBytes)}`;
    case "run_resumed":
      return `run ${state.runId}: ${describeResumption(event.takenOverFrom)}`;
    case "run_cancel_requested":
      return `run ${state.runId}: cancelling: no further agent is dispatched`;
    case "attempt_cancelling": {
      const { attempt } = stepOfAttempt(state, event.attemptId);
      return attemptLine(event.attemptId, `cancelling: stopping the agent (PID ${attempt.pid}) and every process it started`);
    }
  }
}

const describeResumption = (takenOverFrom: LockOwner | null) =>
  `resumed by a new process${takenOverFrom ? `, which took over the stale lock of ${describeOwner(takenOverFrom)}` : ""}`;

const describeOwner = ({ pid, host, startedAt }: LockOwner) => `PID ${pid} on ${host} (started ${startedAt})`;

/** What a person can decide for an attempt that awaits recovery, and how. */
const describeAwaited = (attemptId: string) =>
  `attempt ${attemptId} awaits a decision: \`ahp recover ${attemptId} --policy adopt\` verifies its workspace as the attempt's result, \`ahp recover ${attemptId} --policy abort\` ends the step`;

function describeDecision({ policy, decidedBy, user }: Pick<RecoveryDecision, "policy" | "decidedBy" | "user">): string {
  const what = policy === "adopt" ? "adopt (its workspace is verified as its result)" : "abort (the step ends)";
  return `${what}, decided ${decidedBy === "human" ? `by ${user ?? "a person"}` : "by the step's recovery policy"}`;
}

/** Why an attempt's outcome is unknown, its report, and what was decided. */
function describeRecovery({ reason, detail, report, awaited, decision }: AttemptRecovery): string[] {
  const lines = [`    outcome unknown (${reason}): ${detail}`];
  if (report) lines.push("    recovery report:", ...describeReport(report, "      "));
  if (decision) lines.push(`    recovery: ${describeDecision(decision)}, at ${decision.time}`);
  else lines.push(`    recovery: ${awaited ? "awaits a decision" : "not decided yet"}`);
  return lines;
}

/** A recovery report, line by line, each indented by `indent`. */
function describeReport(report: RecoveryReport, indent: string): string[] {
  const { lastEvents, workspace, refs } = report;
  const lines = ["last events before the attempt was found unknown:", ...lastEvents.map(({ seq, time, type }) => `  | ${seq} ${time} ${type}`)];
  if (!workspace.exists) {
    lines.push(`workspace ${workspace.path}: gone, so there is nothing to adopt`);
  } else if (workspace.error !== null) {
    lines.push(`workspace ${workspace.path}: could not be read: ${workspace.error}`);
  } else {
    const changed = workspace.changed.length === 0 ? "no changes" : `${workspace.changed.length} changed${workspace.truncated ? ", first only" : ""}`;
    lines.push(`workspace ${workspace.path}: ${changed} against the step's base commit`, ...workspace.changed.map((c) => `  | ${describeChange(c)}`));
  }
  if (refs.error !== null) {
    lines.push(`shared refs: could not be compared: ${refs.error}`);
  } else if (refs.changed.length === 0) {
    lines.push("shared refs: unchanged since just before the attempt was dispatched");
  } else {
    lines.push(
      `shared refs: ${refs.changed.length} changed since just before the attempt was dispatched${refs.truncated ? ", first only" : ""}`,
      ...refs.changed.map(({ name, before, after }) => `  | ${name}: ${before ? short(before) : "(none)"} -> ${after ? short(after) : "(none)"}`),
    );
  }
  lines.push(report.toolCallLog === null ? "tool-call log: none, the attempt's adapter keeps none" : "tool-call log:", report.undetermined);
  return lines.map((line) => `${indent}${line}`);
}

/** `n` with its unit, plural unless `n` is 1. */
const quantity = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

const describeTruncation = (droppedBytes: number) =>
  `ledger: truncated a torn last line of ${quantity(droppedBytes, "byte")}, which a write did not finish and so was never recorded`;

/** What the ledger file and the run's lock say: how far the derived state can be trusted, and who is writing it. */
function describeLedger({ state, ledger, lock }: RunInspection): string[] {
  const lines = [`  ledger: ${quantity(ledger.events, "event")}, hash chain intact`];
  for (const { seq, time, droppedBytes } of state.ledgerTruncations) {
    lines.push(`  ${describeTruncation(droppedBytes)} (event ${seq}, ${time})`);
  }
  if (ledger.tornTail) {
    const torn = `the last line (${quantity(ledger.tornTail.bytes, "byte")})`;
    lines.push(
      lock.state === "held"
        ? `  ledger: ${torn} is incomplete, most likely an event the writer is recording right now`
        : `  ledger: ${torn} is torn: a write did not finish, so it was never recorded and is left out; the next process to open the run for writing truncates it`,
    );
  }
  for (const { seq, time, takenOverFrom } of state.resumptions) {
    lines.push(`  resumed: ${time} (event ${seq})${takenOverFrom ? `, taking over the stale lock of ${describeOwner(takenOverFrom)}` : ""}`);
  }
  const holder = describeLockHolder(lock, state);
  if (holder) lines.push(`  lock: ${holder}`);
  for (const attempt of awaitedAttempts(state)) lines.push(`  recovery: ${describeAwaited(attempt.id)}`);
  return lines;
}

/** Who holds the run's lock and what that means for the run; null when there is nothing to say. */
function describeLockHolder(lock: LockState, state: Readonly<RunView>): string | null {
  // A run that is pending or running has a process writing it; any other state is one its process exits at.
  const unfinished = state.state === "pending" || state.state === "running";
  const resume = `\`ahp recover ${state.runId}\``;
  switch (lock.state) {
    case "free":
      return unfinished
        ? `free, yet the run has not ended: the process running it stopped partway, and the run needs recovery: ${resume} examines it and resumes it`
        : null;
    case "unreadable":
      return "the lock file names no owner: it is still being written, or the process writing it stopped first";
  }
  const owner = describeOwner(lock.owner);
  switch (lock.state) {
    case "held":
      return `${owner} is writing the run`;
    case "stale":
      if (unfinished) {
        return `${owner} stopped without finishing the run or releasing its lock: the run needs recovery: ${resume} takes it over, examines the run and resumes it`;
      }
      return state.state === "needs_recovery"
        ? `${owner} stopped the run for a decision without releasing its lock; deciding takes it over`
        : `${owner} ended the run but stopped without releasing its lock; ${resume} removes it`;
    case "other_host":
      return `${owner}, on another host: whether it is still running cannot be checked from here`;
  }
}

/** The attempts a run stopped for, which a person has yet to decide. */
const awaitedAttempts = (state: Readonly<RunView>) =>
  state.steps.flatMap((step) => step.attempts).filter((attempt) => attempt.recovery?.awaited && !attempt.recovery.decision);

/** What `ahp recover` says about a run it had nothing to continue for. */
export function formatUnresumed({ state, takenOverFrom }: ResumeResult): string {
  const lines =
    state.state === "needs_recovery"
      ? [`run ${state.runId}: needs recovery${mockTag(state.mock)}`, ...awaitedAttempts(state).map((attempt) => `  ${describeAwaited(attempt.id)}`)]
      : [`run ${state.runId}: ${state.endedAt !== null ? `already ended (${state.state})` : state.state}${mockTag(state.mock)}; nothing to recover`];
  if (takenOverFrom) lines.push(`  removed the stale lock of ${describeOwner(takenOverFrom)}, which stopped without releasing it`);
  return lines.join("\n");
}

/** A human-readable account of a run's derived state, its ledger and who is writing it. */
export function formatRun(inspection: RunInspection): string {
  const { state } = inspection;
  const lines = [
    `run ${state.runId}: ${state.state}${mockTag(state.mock)}`,
    `  workflow: ${state.workflowName}`,
    `  repo: ${state.repo}`,
    `  base commit: ${state.baseCommit}`,
    `  protocol: ${state.protocolVersion}`,
    `  created: ${state.createdAt}`,
    `  ended: ${state.endedAt ?? "-"}`,
    ...describeLedger(inspection),
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
    const stop = step.state === "failed" ? describeStop(step, state) : null;
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
      if (attempt.sentBack) {
        const { reviewStepId, reviewAttemptId, findings } = attempt.sentBack;
        lines.push(`    sent back by step ${reviewStepId} (attempt ${reviewAttemptId}); its findings:`, ...findings.map((finding) => `      | ${finding}`));
      }
      if (attempt.stopReason) lines.push(`    stop reason: ${attempt.stopReason}`);
      if (attempt.error) lines.push(`    error (${attempt.error.kind}): ${attempt.error.message}`);
      if (attempt.cancellation) {
        const { requestedAt, result } = attempt.cancellation;
        const how = result
          ? describeCancel(result)
          : attempt.state === "exited"
            ? "it had ended by itself before anything was sent to it"
            : "its processes were never seen gone";
        lines.push(`    cancel: from ${requestedAt}, ${how}`);
      }
      if (attempt.recovery) lines.push(...describeRecovery(attempt.recovery));
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
