import type {
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
 * What an exited attempt's record must show for it to have failed as each class. `rejected` has no attempt, and
 * `unknown` is not recorded for an attempt that exited; keyed by every class so a new one cannot be forgotten.
 */
const ATTEMPT_SHOWS: Record<FailureClass, (attempt: AttemptView) => boolean> = {
  rejected: () => false,
  config_auth: (a) => a.outcome === "error",
  transient: (a) => a.outcome === "error",
  agent_error: (a) => a.outcome === "error",
  verification_failed: (a) => a.verification?.state === "fail",
  inconclusive: (a) => a.verification?.state === "inconclusive",
  unknown: () => false,
};

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
        state: "blocked",
        failureClass: null,
        retryUsage: noRetriesSpent(),
        mock: false,
        handoffs: [],
        attempts: [],
      })),
      ledgerTruncations: [],
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
      const s = step(handoff.to.stepId);
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
      const s = step(event.stepId);
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
        snapshot: null,
        verification: null,
        earlierVerifications: [],
      });
      break;
    }
    case "attempt_dispatching":
      attempt(event.attemptId).state = "dispatching";
      break;
    case "attempt_running": {
      const a = attempt(event.attemptId);
      a.state = "running";
      a.pid = event.pid;
      break;
    }
    case "attempt_exited": {
      const a = attempt(event.attemptId);
      a.state = "exited";
      a.outcome = event.outcome;
      a.exitCode = event.exitCode;
      a.signal = event.signal;
      a.reportedOutput = event.reportedOutput;
      a.stopReason = event.stopReason ?? null;
      a.error = event.error ?? null;
      break;
    }
    case "attempt_failed": {
      const a = attempt(event.attemptId);
      if (a.state !== "exited") throw new LedgerInconsistentError(event, `attempt "${a.id}" has not exited`);
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
      s.state = "ready";
      break;
    }
    case "workspace_snapshot_committed":
      attempt(event.attemptId).snapshot = { commit: event.commit, ref: event.ref };
      break;
    case "verification_started": {
      const { step: s, attempt: a } = attemptWithStep(event.attemptId);
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
      // A step succeeds only because verification passed; the ledger may not claim otherwise.
      if (event.state === "succeeded" && s.attempts.at(-1)?.verification?.state !== "pass") {
        throw new LedgerInconsistentError(event, `step "${s.id}" succeeded without a passing verification`);
      }
      s.state = event.state;
      s.failureClass = event.failureClass;
      break;
    }
    case "run_terminal":
      run.state = event.state;
      run.endedAt = event.time;
      break;
    case "ledger_truncated":
      run.ledgerTruncations.push({ seq: event.seq, time: event.time, droppedBytes: event.droppedBytes });
      break;
    default: {
      // A new event type must be handled here: state is derived from events alone.
      const unhandled: never = event;
      throw new LedgerInconsistentError(unhandled, "unknown event type");
    }
  }
  return run;
}
