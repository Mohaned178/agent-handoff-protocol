// What a run waits for a person to decide, as data: a gate to approve or reject, an attempt whose outcome is unknown
// (adopt or abort), or a run whose process stopped (resume). Pure over the replayed state and the lock as last read;
// the run screen shows the decision and the runner carries it out through the SDK.

import type { LockState } from "../ledger/lock.ts";
import type { AttemptView, RunView, StepView } from "../protocol/index.ts";

/** What a person's key does to the run: each is one SDK call. */
export type DecisionRequest =
  | { type: "approve"; stepId: string }
  | { type: "reject"; stepId: string; reason: string }
  | { type: "adopt"; attemptId: string }
  | { type: "abort"; attemptId: string }
  | { type: "resume" };

export type Decision =
  | { kind: "gate"; step: StepView }
  | { kind: "unknown"; step: StepView; attempt: AttemptView }
  | { kind: "stopped" };

/** The gate with an open approval request, if the run waits at one. */
export const openGateOf = (state: Readonly<RunView>): StepView | undefined =>
  state.steps.find((step) => step.kind === "approval_gate" && step.state === "waiting_approval" && step.approvals.at(-1)?.decision === null);

/** The attempt that awaits a person's recovery decision, if one does. */
export function awaitedAttemptOf(state: Readonly<RunView>): { step: StepView; attempt: AttemptView } | undefined {
  for (const step of state.steps) {
    const attempt = step.attempts.find((candidate) => candidate.state === "unknown" && candidate.recovery?.awaited === true && candidate.recovery.decision === null);
    if (attempt) return { step, attempt };
  }
  return undefined;
}

/**
 * What the person can decide now, or null: the run ended, a live process is writing it (this one's own run included, which
 * decides itself), or the lock has not been read yet. A lock nobody holds or a stale one leaves the run to the person.
 */
export function decisionOf(state: Readonly<RunView>, lock: LockState | null): Decision | null {
  if (state.endedAt !== null || lock === null || lock.state === "held" || lock.state === "other_host" || lock.state === "unreadable") return null;
  const gate = openGateOf(state);
  if (gate) return { kind: "gate", step: gate };
  const awaited = awaitedAttemptOf(state);
  if (awaited) return { kind: "unknown", ...awaited };
  // A free lock on a run that has not ended and waits for nothing is a process that stopped before it took the lock or
  // after it let go: it needs resuming the same way.
  return { kind: "stopped" };
}
