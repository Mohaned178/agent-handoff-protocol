import { isApprovalGate, isPresentOutputField, reviewFindingsOf, reviewVerdictOf } from "../protocol/index.ts";
import type {
  AttemptRecovery,
  AttemptState,
  AttemptView,
  FailureClass,
  HandoffView,
  LedgerEvent,
  RetryChange,
  RetryUsage,
  RunView,
  StepView,
  VerificationView,
} from "../protocol/index.ts";

/** Finds an attempt, and the step it belongs to, in derived state. */
export function findAttempt(
  run: Readonly<RunView>,
  attemptId: string,
): { step: StepView; attempt: AttemptView } | undefined {
  for (const step of run.steps) {
    const attempt = step.attempts.find((a) => a.id === attemptId);
    if (attempt) return { step, attempt };
  }
  return undefined;
}

/** Finds a verification, and the step and attempt it belongs to, in derived state. */
export function findVerification(
  run: Readonly<RunView>,
  verificationId: string,
): { step: StepView; attempt: AttemptView; verification: VerificationView } | undefined {
  for (const step of run.steps) {
    for (const attempt of step.attempts) {
      if (attempt.verification?.id === verificationId) return { step, attempt, verification: attempt.verification };
    }
  }
  return undefined;
}

/** Finds a handoff revision, and the step it was issued to, in derived state. */
export function findHandoff(
  run: Readonly<RunView>,
  handoffId: string,
  revision: number,
): { step: StepView; handoff: HandoffView } | undefined {
  for (const step of run.steps) {
    const handoff = step.handoffs.find((h) => h.handoffId === handoffId && h.revision === revision);
    if (handoff) return { step, handoff };
  }
  return undefined;
}

const noRetriesSpent = (): RetryUsage => ({ retries: 0, transientRetries: 0, transientWaitMs: 0, rerouted: false });

/**
 * What an attempt's record must show for it to have failed as each class. `rejected` has no attempt, and `unknown`
 * is recorded only for an unknown attempt whose recovery aborted it; keyed by every class so a new one cannot be
 * forgotten.
 */
const ATTEMPT_SHOWS: Record<FailureClass, (attempt: AttemptView) => boolean> = {
  rejected: () => false,
  config_auth: (a) => a.outcome === "error",
  transient: (a) => a.outcome === "error",
  agent_error: (a) => a.outcome === "error",
  verification_failed: (a) => a.verification?.state === "fail",
  inconclusive: (a) => a.verification?.state === "inconclusive",
  unknown: (a) => a.recovery?.decision?.policy === "abort",
};

/**
 * Whether the attempt has a result in its workspace to snapshot and verify: its process exited, or its outcome is
 * unknown and its workspace was adopted as the result.
 */
const hasResult = (a: AttemptView) => a.state === "exited" || a.recovery?.decision?.policy === "adopt";

/** How a failure of each class may be retried; a class with none is never retried. */
const RETRIED_WITH: Record<FailureClass, readonly RetryChange[]> = {
  rejected: [],
  config_auth: [],
  transient: ["none", "reroute"],
  agent_error: ["none", "reroute"],
  verification_failed: ["evidence", "reroute"],
  inconclusive: [],
  unknown: [],
};

/** The recovery of an attempt whose outcome is unknown and not yet decided; an event about any other attempt is refused. */
function undecidedRecovery(a: AttemptView, event: LedgerEvent): AttemptRecovery {
  if (!a.recovery) throw new LedgerInconsistentError(event, `attempt "${a.id}" is ${a.state}, not unknown`);
  if (a.recovery.decision) {
    throw new LedgerInconsistentError(event, `attempt "${a.id}"'s recovery was already decided (${a.recovery.decision.policy})`);
  }
  return a.recovery;
}

/** The ledger's events do not describe a valid run. */
export class LedgerInconsistentError extends Error {
  override name = "LedgerInconsistentError";
  constructor(event: LedgerEvent, problem: string) {
    super(`ledger event ${event.seq} (${event.type}): ${problem}`);
  }
}

/** Derives run, step, attempt and verification state from a run's ledger events. */
export function replay(events: readonly LedgerEvent[]): RunView {
  let state: RunView | undefined;
  for (const event of events) state = applyEvent(state, event);
  if (!state) throw new Error("ledger is empty");
  return state;
}

/**
 * Applies one event to the derived state. The first event must be `run_created`, which creates the state;
 * every later event updates `state` in place and returns it.
 */
export function applyEvent(state: RunView | undefined, event: LedgerEvent): RunView {
  if (event.type === "run_created") {
    if (state) throw new LedgerInconsistentError(event, "run already created");
    return {
      runId: event.runId,
      protocolVersion: event.protocolVersion,
      workflowName: event.workflow.name,
      state: "pending",
      repo: event.repo,
      baseCommit: event.baseCommit,
      mock: false,
      createdAt: event.time,
      endedAt: null,
      steps: event.workflow.steps.map((step) => ({
        id: step.id,
        kind: isApprovalGate(step) ? "approval_gate" : step.review ? "review" : "agent",
        state: "blocked",
        failureClass: null,
        retryUsage: noRetriesSpent(),
        mock: false,
        handoffs: [],
        attempts: [],
        approvals: [],
      })),
      ledgerTruncations: [],
      resumptions: [],
      cancelRequestedAt: null,
    };
  }
  if (!state) throw new LedgerInconsistentError(event, "the first event must be run_created");
  const run = state;

  const step = (stepId: string): StepView => {
    const found = run.steps.find((s) => s.id === stepId);
    if (!found) throw new LedgerInconsistentError(event, `unknown step "${stepId}"`);
    return found;
  };
  const attemptWithStep = (attemptId: string) => {
    const found = findAttempt(run, attemptId);
    if (!found) throw new LedgerInconsistentError(event, `unknown attempt "${attemptId}"`);
    return found;
  };
  const attempt = (attemptId: string): AttemptView => attemptWithStep(attemptId).attempt;
  /** The attempt, which the event's own step in its lifecycle requires to be in `state`. */
  const attemptIn = (attemptId: string, state: AttemptState): AttemptView => {
    const a = attempt(attemptId);
    if (a.state !== state) throw new LedgerInconsistentError(event, `attempt "${a.id}" is ${a.state}, not ${state}`);
    return a;
  };
  /** Refuses an event that would start something new once the run is being cancelled. */
  const refuseAfterCancel = (what: string) => {
    if (run.cancelRequestedAt !== null) throw new LedgerInconsistentError(event, `the run is being cancelled, so ${what}`);
  };
  /** The step, which an event that needs a coding agent refuses to be about an approval gate. */
  const agentStep = (stepId: string): StepView => {
    const found = step(stepId);
    if (found.kind === "approval_gate") throw new LedgerInconsistentError(event, `step "${found.id}" is an approval gate, which has no coding agent`);
    return found;
  };
  /** The step, which an approval event requires to be an approval gate. */
  const gateStep = (stepId: string): StepView => {
    const found = step(stepId);
    if (found.kind !== "approval_gate") throw new LedgerInconsistentError(event, `step "${found.id}" is not an approval gate`);
    return found;
  };
  /** The issued handoff revision a decision applies to; only an `issued` revision can be decided. */
  const issuedHandoff = (handoffId: string, revision: number): HandoffView => {
    const found = findHandoff(run, handoffId, revision);
    if (!found) throw new LedgerInconsistentError(event, `unknown handoff ${handoffId} revision ${revision}`);
    if (found.handoff.state !== "issued") {
      throw new LedgerInconsistentError(event, `handoff ${handoffId} revision ${revision} is already ${found.handoff.state}`);
    }
    return found.handoff;
  };

  switch (event.type) {
    case "run_started":
      run.state = "running";
      break;
    case "step_ready":
      step(event.stepId).state = "ready";
      break;
    case "handoff_issued": {
      const { handoff } = event;
      const s = agentStep(handoff.to.stepId);
      // Revisions are immutable and numbered in order: a change is always the next revision, which
      // supersedes the one before it. Nothing re-issues or skips a revision.
      const earlier = s.handoffs.filter((h) => h.handoffId === handoff.handoffId);
      if (handoff.revision !== earlier.length + 1 || handoff.supersedes !== (earlier.length === 0 ? null : earlier.length)) {
        throw new LedgerInconsistentError(
          event,
          `handoff ${handoff.handoffId} revision ${handoff.revision} (supersedes ${handoff.supersedes}) does not follow its ${earlier.length} earlier revision(s)`,
        );
      }
      const previous = earlier.at(-1);
      if (previous) previous.state = "superseded";
      s.handoffs.push({
        handoffId: handoff.handoffId,
        revision: handoff.revision,
        supersedes: handoff.supersedes,
        state: "issued",
        handoff,
        rejection: null,
      });
      break;
    }
    case "handoff_accepted":
      issuedHandoff(event.handoffId, event.revision).state = "accepted";
      break;
    case "handoff_rejected": {
      const view = issuedHandoff(event.handoffId, event.revision);
      view.state = "rejected";
      view.rejection = event.reasons;
      break;
    }
    case "attempt_created": {
      const s = agentStep(event.stepId);
      // An attempt runs only under a handoff revision the recipient has accepted.
      const handoff = s.handoffs.find((h) => h.handoffId === event.handoffId && h.revision === event.handoffRevision);
      if (handoff?.state !== "accepted") {
        throw new LedgerInconsistentError(
          event,
          `attempt "${event.attemptId}" runs under handoff ${event.handoffId} revision ${event.handoffRevision}, which is not accepted`,
        );
      }
      // The idempotency key is (handoff, revision, attempt): an attempt ID is never used twice, and a step starts
      // an attempt only when it is ready for one, which a retry makes it again.
      if (findAttempt(run, event.attemptId)) {
        throw new LedgerInconsistentError(event, `attempt "${event.attemptId}" already exists`);
      }
      if (s.state !== "ready") {
        throw new LedgerInconsistentError(event, `step "${s.id}" is ${s.state}, not ready for an attempt`);
      }
      refuseAfterCancel("no attempt is created");
      s.state = "in_progress";
      s.mock ||= event.mock;
      run.mock ||= event.mock;
      s.attempts.push({
        id: event.attemptId,
        number: s.attempts.length + 1,
        state: "created",
        handoff: { id: event.handoffId, revision: event.handoffRevision },
        outcome: null,
        exitCode: null,
        signal: null,
        reportedOutput: {},
        stopReason: null,
        error: null,
        failureClass: null,
        pid: null,
        adapter: event.adapter,
        mock: event.mock,
        requestedModel: event.requestedModel,
        reportedModel: "unknown",
        workspace: event.workspace,
        refs: { before: null, after: null },
        snapshot: null,
        verification: null,
        earlierVerifications: [],
        retry: null,
        sentBack: null,
        recovery: null,
        cancellation: null,
      });
      break;
    }
    case "attempt_dispatching": {
      // An attempt is dispatched once: one with a dispatching record may have an agent running, and is never dispatched again.
      const a = attemptIn(event.attemptId, "created");
      refuseAfterCancel("no agent is dispatched");
      a.state = "dispatching";
      break;
    }
    case "attempt_running": {
      const a = attemptIn(event.attemptId, "dispatching");
      a.state = "running";
      a.pid = event.pid;
      break;
    }
    case "attempt_exited": {
      const a = attemptIn(event.attemptId, "running");
      // Only an attempt being cancelled ends cancelled, saying how its agent was stopped. One being cancelled may still
      // exit with its own outcome: it had ended by itself before anything was sent to it.
      const cancel = event.cancel ?? null;
      if ((event.outcome === "cancelled") !== (cancel !== null)) {
        throw new LedgerInconsistentError(event, `attempt "${a.id}": a cancelled outcome, and only one, says how the agent was stopped`);
      }
      if (cancel && !a.cancellation) throw new LedgerInconsistentError(event, `attempt "${a.id}" was not being cancelled`);
      if (cancel && cancel.forced !== (cancel.via === "tree_kill")) {
        throw new LedgerInconsistentError(event, `attempt "${a.id}": a cancel is forced exactly when the process tree was killed`);
      }
      if (a.cancellation) a.cancellation.result = cancel;
      a.state = "exited";
      a.outcome = event.outcome;
      a.exitCode = event.exitCode;
      a.signal = event.signal;
      a.reportedOutput = event.reportedOutput;
      a.stopReason = event.stopReason ?? null;
      a.error = event.error ?? null;
      break;
    }
    case "attempt_unknown": {
      const { step: s, attempt: a } = attemptWithStep(event.attemptId);
      // Only a dispatched attempt can have done something nobody saw: one that never was dispatched ran no agent.
      if (a.state !== "dispatching" && a.state !== "running") {
        throw new LedgerInconsistentError(event, `attempt "${a.id}" is ${a.state}, not dispatched and unfinished`);
      }
      if (event.reason === "unconfirmed_kill" && !a.cancellation) {
        throw new LedgerInconsistentError(event, `attempt "${a.id}" was never being cancelled, so nothing killed it`);
      }
      a.state = "unknown";
      a.recovery = { reason: event.reason, detail: event.detail, report: null, awaited: false, decision: null };
      s.state = "needs_recovery";
      break;
    }
    case "recovery_report_written": {
      const recovery = undecidedRecovery(attempt(event.attemptId), event);
      if (recovery.report) throw new LedgerInconsistentError(event, `attempt "${event.attemptId}" already has a recovery report`);
      recovery.report = event.report;
      break;
    }
    case "recovery_awaited": {
      const recovery = undecidedRecovery(attempt(event.attemptId), event);
      if (!recovery.report || recovery.awaited) {
        throw new LedgerInconsistentError(event, `attempt "${event.attemptId}" has ${recovery.report ? "already stopped the run" : "no recovery report"}`);
      }
      recovery.awaited = true;
      run.state = "needs_recovery";
      break;
    }
    case "recovery_decided": {
      const { step: s, attempt: a } = attemptWithStep(event.attemptId);
      const recovery = undecidedRecovery(a, event);
      if (!recovery.report) throw new LedgerInconsistentError(event, `attempt "${a.id}" has no recovery report`);
      // A person decides for a run that stopped to wait for one; the step's own policy decides at once, without stopping.
      if (recovery.awaited !== (event.decidedBy === "human")) {
        throw new LedgerInconsistentError(event, `attempt "${a.id}" ${recovery.awaited ? "awaits a person's decision" : "was not left to a person"}`);
      }
      recovery.decision = { policy: event.policy, decidedBy: event.decidedBy, user: event.user, time: event.time };
      s.state = "in_progress";
      run.state = "running";
      break;
    }
    case "attempt_failed": {
      const a = attempt(event.attemptId);
      if (a.state !== "exited" && a.state !== "unknown") throw new LedgerInconsistentError(event, `attempt "${a.id}" has not exited`);
      if (a.failureClass !== null) throw new LedgerInconsistentError(event, `attempt "${a.id}" is already classified ${a.failureClass}`);
      // The class must follow from what the ledger says happened to the attempt, so it cannot claim otherwise.
      if (!ATTEMPT_SHOWS[event.failureClass](a)) {
        throw new LedgerInconsistentError(event, `attempt "${a.id}" cannot have failed as ${event.failureClass}`);
      }
      a.failureClass = event.failureClass;
      break;
    }
    case "retry_scheduled": {
      const s = step(event.stepId);
      const failed = s.attempts.at(-1);
      if (s.state === "succeeded" || s.state === "failed") {
        throw new LedgerInconsistentError(event, `step "${s.id}" is already ${s.state}`);
      }
      if (failed?.id !== event.attemptId || failed.failureClass !== event.failureClass) {
        throw new LedgerInconsistentError(event, `attempt "${event.attemptId}" is not the failed last attempt of step "${s.id}"`);
      }
      // Its agent may still be running, so no new agent follows it, adopted or not.
      if (failed.state === "unknown") throw new LedgerInconsistentError(event, `attempt "${failed.id}" is unknown, so it is never retried`);
      if (!RETRIED_WITH[event.failureClass].includes(event.change)) {
        throw new LedgerInconsistentError(event, `${event.failureClass} failures are not retried with change "${event.change}"`);
      }
      const usage = s.retryUsage;
      if (event.change === "reroute") {
        if (usage.rerouted) throw new LedgerInconsistentError(event, `step "${s.id}" was already rerouted`);
        s.retryUsage = { ...noRetriesSpent(), rerouted: true };
      } else if (event.failureClass === "transient") {
        usage.transientRetries += 1;
        usage.transientWaitMs += event.delayMs;
      } else {
        usage.retries += 1;
      }
      failed.retry = { change: event.change, delayMs: event.delayMs, scheduledAt: event.time };
      s.state = "ready";
      break;
    }
    case "step_sent_back": {
      const target = step(event.stepId);
      const reviewer = step(event.reviewStepId);
      refuseAfterCancel("no step is sent back");
      // A send-back reaches the step immediately before the review, which had succeeded, and no other.
      if (run.steps.indexOf(target) !== run.steps.indexOf(reviewer) - 1) {
        throw new LedgerInconsistentError(event, `step "${target.id}" is not the step immediately before "${reviewer.id}", the only one it sends back`);
      }
      const sent = target.attempts.at(-1);
      if (target.state !== "succeeded" || sent?.id !== event.attemptId) {
        throw new LedgerInconsistentError(event, `step "${target.id}" is ${target.state}, not succeeded with attempt "${event.attemptId}" as its last`);
      }
      if (sent.sentBack !== null) throw new LedgerInconsistentError(event, `attempt "${sent.id}" was already sent back`);
      // The review's own verification passed, and what it reported asks for changes and says what: a send-back never
      // carries empty evidence.
      const review = reviewer.attempts.at(-1);
      if (reviewer.state !== "verifying" || review?.id !== event.reviewAttemptId || review.state !== "exited" || review.verification?.state !== "pass") {
        throw new LedgerInconsistentError(event, `attempt "${event.reviewAttemptId}" is not the passed verified last attempt of review step "${reviewer.id}"`);
      }
      const findings = reviewFindingsOf(review.reportedOutput);
      if (reviewVerdictOf(review.reportedOutput) !== "changes_requested" || findings.length === 0) {
        throw new LedgerInconsistentError(event, `attempt "${review.id}" did not request changes with findings`);
      }
      // The same budget as a failed verification: a send-back is that retry (ADR 0004).
      target.retryUsage.retries += 1;
      sent.sentBack = { kind: "review", reviewStepId: reviewer.id, reviewAttemptId: review.id, findings };
      sent.retry = { change: "evidence", delayMs: 0, scheduledAt: event.time };
      target.state = "ready";
      // The review is done again, on the new result, once there is one.
      reviewer.state = "blocked";
      break;
    }
    case "approval_requested": {
      const gate = gateStep(event.stepId);
      refuseAfterCancel("no approval is requested");
      if (run.state !== "running" || gate.state !== "ready") {
        throw new LedgerInconsistentError(event, `step "${gate.id}" is ${gate.state} in a ${run.state} run, not ready in a running one`);
      }
      // What is put to the approver is the verified result of the step immediately before the gate, as it is now.
      const before = run.steps[run.steps.indexOf(gate) - 1];
      const verified = before?.attempts.at(-1);
      if (!before || before.state !== "succeeded" || verified?.id !== event.attemptId || verified.verification?.state !== "pass") {
        throw new LedgerInconsistentError(event, `attempt "${event.attemptId}" is not the verified last attempt of the succeeded step before gate "${gate.id}"`);
      }
      if (verified.snapshot?.commit !== event.commit || event.base !== run.baseCommit) {
        throw new LedgerInconsistentError(event, `the request does not name the run's base commit and attempt "${verified.id}"'s snapshot`);
      }
      gate.state = "waiting_approval";
      run.state = "waiting_approval";
      gate.approvals.push({
        attemptId: event.attemptId,
        requestedAt: event.time,
        base: event.base,
        commit: event.commit,
        changed: event.changed,
        truncated: event.truncated,
        decision: null,
      });
      break;
    }
    case "approval_decided": {
      const gate = gateStep(event.stepId);
      const open = gate.approvals.at(-1);
      if (run.state !== "waiting_approval" || gate.state !== "waiting_approval" || !open || open.decision) {
        throw new LedgerInconsistentError(event, `step "${gate.id}" has no open request for approval`);
      }
      // A rejection is sent back with its reason, so it is never empty; an approval has none.
      if (event.decision === "rejected" ? !isPresentOutputField(event.reason) : event.reason !== null) {
        throw new LedgerInconsistentError(event, event.decision === "rejected" ? "a rejection needs a reason" : "an approval carries no reason");
      }
      open.decision = { decision: event.decision, reason: event.reason, user: event.user, time: event.time };
      run.state = "running";
      break;
    }
    case "approval_sent_back": {
      const target = agentStep(event.stepId);
      const gate = gateStep(event.gateStepId);
      refuseAfterCancel("no step is sent back");
      if (run.steps.indexOf(target) !== run.steps.indexOf(gate) - 1) {
        throw new LedgerInconsistentError(event, `step "${target.id}" is not the step immediately before "${gate.id}", the only one it sends back`);
      }
      const sent = target.attempts.at(-1);
      if (target.state !== "succeeded" || sent?.id !== event.attemptId) {
        throw new LedgerInconsistentError(event, `step "${target.id}" is ${target.state}, not succeeded with attempt "${event.attemptId}" as its last`);
      }
      const rejection = gate.approvals.at(-1);
      const decision = rejection?.decision;
      if (gate.state !== "waiting_approval" || decision?.decision !== "rejected" || rejection!.attemptId !== sent.id) {
        throw new LedgerInconsistentError(event, `gate "${gate.id}" has no rejection of attempt "${sent.id}"`);
      }
      // The same budget as a failed verification: a send-back is that retry (ADR 0004).
      target.retryUsage.retries += 1;
      sent.sentBack = { kind: "approval", gateStepId: gate.id, reason: decision.reason!, user: decision.user, decidedAt: decision.time };
      sent.retry = { change: "evidence", delayMs: 0, scheduledAt: event.time };
      target.state = "ready";
      // The gate asks again, on the new result, once there is one.
      gate.state = "blocked";
      break;
    }
    case "ref_snapshot_taken": {
      const a = attempt(event.attemptId);
      // Before: while the attempt waits to be dispatched. After: once its process has exited or been found unknown.
      const when = event.phase === "before" ? ["created"] : ["exited", "unknown"];
      if (!when.includes(a.state)) throw new LedgerInconsistentError(event, `attempt "${a.id}" is ${a.state}, not ${when.join(" or ")}`);
      a.refs[event.phase] = event.refs;
      break;
    }
    case "workspace_snapshot_committed": {
      const a = attempt(event.attemptId);
      if (!hasResult(a)) throw new LedgerInconsistentError(event, `attempt "${a.id}" has no result to snapshot`);
      a.snapshot = { commit: event.commit, ref: event.ref };
      break;
    }
    case "verification_started": {
      const { step: s, attempt: a } = attemptWithStep(event.attemptId);
      if (!hasResult(a)) throw new LedgerInconsistentError(event, `attempt "${a.id}" has no result to verify`);
      // A verification that could not run is re-run once; any other verdict is final.
      if (a.verification) {
        if (a.verification.state !== "inconclusive" || a.earlierVerifications.length > 0) {
          throw new LedgerInconsistentError(event, `attempt "${a.id}" is already verified (${a.verification.state})`);
        }
        a.earlierVerifications.push(a.verification);
      }
      a.verification = {
        id: event.verificationId,
        state: "pending",
        command: event.command,
        worktree: event.worktree,
        evidence: [],
      };
      s.state = "verifying";
      break;
    }
    case "verification_verdict": {
      const found = findVerification(run, event.verificationId);
      if (!found) throw new LedgerInconsistentError(event, `unknown verification "${event.verificationId}"`);
      found.verification.state = event.verdict;
      found.verification.evidence = event.evidence;
      break;
    }
    case "step_terminal": {
      const s = step(event.stepId);
      // A step succeeds only because verification passed, a gate only because a person approved; the ledger may not
      // claim otherwise. A gate fails only because a person rejected and the step before it cannot be sent back again.
      if (s.kind === "approval_gate") {
        const decided = s.approvals.at(-1)?.decision?.decision;
        if (event.state === "succeeded" && (s.state !== "waiting_approval" || decided !== "approved")) {
          throw new LedgerInconsistentError(event, `gate "${s.id}" succeeded without an approval`);
        }
        if (event.state === "failed" && (s.state !== "waiting_approval" || decided !== "rejected")) {
          throw new LedgerInconsistentError(event, `gate "${s.id}" failed without a rejection`);
        }
      } else if (event.state === "succeeded" && s.attempts.at(-1)?.verification?.state !== "pass") {
        throw new LedgerInconsistentError(event, `step "${s.id}" succeeded without a passing verification`);
      }
      if (event.state === "cancelled") {
        if (run.cancelRequestedAt === null) throw new LedgerInconsistentError(event, "nobody cancelled the run");
        // Nothing may be left that an agent could still be doing, or that waits for a person's decision.
        const last = s.attempts.at(-1);
        if (last && last.state !== "created" && last.state !== "exited") {
          throw new LedgerInconsistentError(event, `step "${s.id}"'s attempt "${last.id}" is ${last.state}`);
        }
        if (event.failureClass !== null) throw new LedgerInconsistentError(event, "a cancelled step has no failure class");
      }
      s.state = event.state;
      s.failureClass = event.failureClass;
      break;
    }
    case "run_terminal":
      if (event.state === "cancelled" && run.cancelRequestedAt === null) throw new LedgerInconsistentError(event, "nobody cancelled the run");
      run.state = event.state;
      run.endedAt = event.time;
      break;
    case "ledger_truncated":
      run.ledgerTruncations.push({ seq: event.seq, time: event.time, droppedBytes: event.droppedBytes });
      break;
    case "run_cancel_requested":
      if (run.state !== "running" || run.cancelRequestedAt !== null) {
        throw new LedgerInconsistentError(event, run.cancelRequestedAt !== null ? "the run is already being cancelled" : `the run is ${run.state}, not running`);
      }
      run.cancelRequestedAt = event.time;
      break;
    case "attempt_cancelling": {
      const a = attemptIn(event.attemptId, "running");
      if (run.cancelRequestedAt === null) throw new LedgerInconsistentError(event, "nobody cancelled the run");
      if (a.cancellation) throw new LedgerInconsistentError(event, `attempt "${a.id}" is already being cancelled`);
      a.cancellation = { requestedAt: event.time, result: null };
      break;
    }
    case "run_resumed":
      if (run.endedAt !== null) throw new LedgerInconsistentError(event, `the run already ended ${run.state}`);
      run.resumptions.push({ seq: event.seq, time: event.time, takenOverFrom: event.takenOverFrom });
      break;
    default: {
      // A new event type must be handled here: state is derived from events alone.
      const unhandled: never = event;
      throw new LedgerInconsistentError(unhandled, "unknown event type");
    }
  }
  return run;
}
