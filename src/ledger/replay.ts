import type { AttemptView, LedgerEvent, RunView, StepView, VerificationView } from "../protocol/index.ts";

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
        mock: false,
        attempts: [],
      })),
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

  switch (event.type) {
    case "run_started":
      run.state = "running";
      break;
    case "step_ready":
      step(event.stepId).state = "ready";
      break;
    case "attempt_created": {
      const s = step(event.stepId);
      s.state = "in_progress";
      s.mock ||= event.mock;
      run.mock ||= event.mock;
      s.attempts.push({
        id: event.attemptId,
        number: s.attempts.length + 1,
        state: "created",
        outcome: null,
        exitCode: null,
        signal: null,
        pid: null,
        adapter: event.adapter,
        mock: event.mock,
        requestedModel: event.requestedModel,
        reportedModel: "unknown",
        workspace: event.workspace,
        snapshot: null,
        verification: null,
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
      break;
    }
    case "workspace_snapshot_committed":
      attempt(event.attemptId).snapshot = { commit: event.commit, ref: event.ref };
      break;
    case "verification_started": {
      const { step: s, attempt: a } = attemptWithStep(event.attemptId);
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
  }
  return run;
}
