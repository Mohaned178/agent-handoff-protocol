import type { ConditionId, EvaluationEvent, FrozenFile } from "./events.ts";
import { CONDITIONS } from "./events.ts";

/** A ledger whose events do not follow from each other, in a way a hash chain does not catch (a trial that ends twice). */
export class EvaluationLedgerInconsistentError extends Error {
  override name = "EvaluationLedgerInconsistentError";
  constructor(event: EvaluationEvent, problem: string) {
    super(`evaluation ledger event ${event.seq} (${event.type}): ${problem}`);
  }
}

/** A task as it was frozen. */
export interface TaskView {
  id: string;
  dir: string;
  hash: string;
  hiddenTestsHash: string;
  files: FrozenFile[];
  hiddenTests: string[];
  constraints: string[];
  seededDefects: string[];
  /** The sequence number of the `task_frozen` event: every one comes before the first `trial_started`. */
  frozenAtSeq: number;
  frozenAt: string;
}

export type TrialEnded = Extract<EvaluationEvent, { type: "trial_ended" }>;
type HarnessIncident = Extract<EvaluationEvent, { type: "harness_incident" }>;

export interface TrialView {
  id: string;
  taskId: string;
  condition: ConditionId;
  startedAtSeq: number;
  startedAt: string;
  endedAt: string | null;
  repo: string;
  /** Set when an attempt of the trial's run was unknown; the trial then ends as a harness incident. */
  incident: Pick<HarnessIncident, "attemptId" | "unknownReason" | "detail"> | null;
  /** Null while the trial runs. */
  ended: TrialEnded | null;
}

export type EvaluationState = "running" | "completed" | "stopped" | "cancelled";

export interface EvaluationView {
  evaluationId: string;
  protocolVersion: string;
  suite: string;
  conditions: ConditionId[];
  retryBudget: number;
  state: EvaluationState;
  /** Why it stopped, if it did (`task_changed`). */
  reason: string | null;
  createdAt: string;
  endedAt: string | null;
  tasks: TaskView[];
  trials: TrialView[];
  taskChanges: Extract<EvaluationEvent, { type: "task_changed" }>[];
  /** True when any trial ran on the mock adapter: the evaluation's results are not evidence. */
  mock: boolean;
  ledgerTruncations: number;
}

/** Derives an evaluation's state from the events of its ledger. */
export function replayEvaluation(events: readonly EvaluationEvent[]): EvaluationView {
  let state: EvaluationView | undefined;
  for (const event of events) state = applyEvaluationEvent(state, event);
  if (!state) throw new Error("evaluation ledger is empty");
  return state;
}

/** Applies one event; the first must be `evaluation_created`. The state is updated in place and returned. */
export function applyEvaluationEvent(state: EvaluationView | undefined, event: EvaluationEvent): EvaluationView {
  if (event.type === "evaluation_created") {
    if (state) throw new EvaluationLedgerInconsistentError(event, "evaluation already created");
    return {
      evaluationId: event.evaluationId,
      protocolVersion: event.protocolVersion,
      suite: event.suite,
      conditions: event.conditions,
      retryBudget: event.retryBudget,
      state: "running",
      reason: null,
      createdAt: event.time,
      endedAt: null,
      tasks: [],
      trials: [],
      taskChanges: [],
      mock: false,
      ledgerTruncations: 0,
    };
  }
  if (!state) throw new EvaluationLedgerInconsistentError(event, "the first event of an evaluation ledger is evaluation_created");
  const trial = (id: string) => {
    const found = state.trials.find((candidate) => candidate.id === id);
    if (!found) throw new EvaluationLedgerInconsistentError(event, `trial "${id}" was never started`);
    return found;
  };
  switch (event.type) {
    case "task_frozen":
      // The freeze comes first: a task frozen after a trial began could have been tuned by what that trial showed.
      if (state.trials.length > 0) throw new EvaluationLedgerInconsistentError(event, "a task was frozen after a trial had started");
      if (state.tasks.some((task) => task.id === event.taskId)) throw new EvaluationLedgerInconsistentError(event, `task "${event.taskId}" is frozen twice`);
      state.tasks.push({
        id: event.taskId,
        dir: event.dir,
        hash: event.taskHash,
        hiddenTestsHash: event.hiddenTestsHash,
        files: event.files,
        hiddenTests: event.hiddenTests,
        constraints: event.constraints,
        seededDefects: event.seededDefects,
        frozenAtSeq: event.seq,
        frozenAt: event.time,
      });
      return state;
    case "trial_started":
      if (!state.tasks.some((task) => task.id === event.taskId)) throw new EvaluationLedgerInconsistentError(event, `task "${event.taskId}" was never frozen`);
      if (!CONDITIONS.includes(event.condition) || !state.conditions.includes(event.condition)) throw new EvaluationLedgerInconsistentError(event, `condition ${event.condition} is not one of this evaluation's`);
      if (state.trials.some((candidate) => candidate.id === event.trialId)) throw new EvaluationLedgerInconsistentError(event, `trial "${event.trialId}" started twice`);
      state.trials.push({ id: event.trialId, taskId: event.taskId, condition: event.condition, startedAtSeq: event.seq, startedAt: event.time, endedAt: null, repo: event.repo, incident: null, ended: null });
      return state;
    case "harness_incident": {
      const found = trial(event.trialId);
      if (found.ended) throw new EvaluationLedgerInconsistentError(event, `trial "${found.id}" has ended`);
      found.incident = { attemptId: event.attemptId, unknownReason: event.unknownReason, detail: event.detail };
      return state;
    }
    case "trial_ended": {
      const found = trial(event.trialId);
      if (found.ended) throw new EvaluationLedgerInconsistentError(event, `trial "${found.id}" ended twice`);
      if (event.outcome === "scored" && !event.score) throw new EvaluationLedgerInconsistentError(event, "a scored trial has a score");
      if (event.outcome !== "scored" && event.score) throw new EvaluationLedgerInconsistentError(event, `a trial that is ${event.outcome} has no score`);
      if (event.outcome === "harness_incident" && !found.incident) throw new EvaluationLedgerInconsistentError(event, "a harness incident is recorded before its trial ends");
      if (event.outcome === "unscored" && !event.unscored) throw new EvaluationLedgerInconsistentError(event, "an unscored trial says why");
      found.ended = event;
      found.endedAt = event.time;
      if (event.mock) state.mock = true;
      return state;
    }
    case "task_changed":
      if (!state.tasks.some((task) => task.id === event.taskId)) throw new EvaluationLedgerInconsistentError(event, `task "${event.taskId}" was never frozen`);
      state.taskChanges.push(event);
      return state;
    case "evaluation_ended":
      state.state = event.state;
      state.reason = event.reason;
      state.endedAt = event.time;
      return state;
    case "ledger_truncated":
      state.ledgerTruncations += 1;
      return state;
    default: {
      const unhandled: never = event;
      throw new Error(`unhandled evaluation event ${JSON.stringify(unhandled)}`);
    }
  }
}
