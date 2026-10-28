import type { BaselineSlot, ConditionId, EvaluationEvent, FrozenFile, Safeguards, ScheduledTrial, ToolVersionRecord } from "./events.ts";
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
  repeat: number;
  /** Set for a trial of the matched-budget baseline. */
  baseline: BaselineSlot | null;
  startedAtSeq: number;
  startedAt: string;
  /** The tools the trial's agents run on, with their versions. */
  tools: ToolVersionRecord[];
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
  repeats: number;
  safeguards: Safeguards;
  /** The last spend observed (`spend_observed`); null before one, and always with no cap. */
  spend: { currency: string; amount: number; attemptsWithoutCost: number } | null;
  /** The seed of the trial order and of the comparisons' resampling; null until the trials are scheduled. */
  seed: number | null;
  /**
   * The trials still to start, the next first; null until they are scheduled. What is left when the evaluation ends was never
   * run (it stopped or was cancelled).
   */
  pending: ScheduledTrial[] | null;
  /** The matched-budget baseline of each scored C3 trial that got one: how many C0 trials it scheduled. */
  baselines: { forTrialId: string; taskId: string; repeat: number; trials: number }[];
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

const isSameTrial = (a: ScheduledTrial, b: ScheduledTrial) =>
  a.taskId === b.taskId &&
  a.condition === b.condition &&
  a.repeat === b.repeat &&
  a.baseline?.forTrialId === b.baseline?.forTrialId &&
  a.baseline?.index === b.baseline?.index &&
  a.baseline?.of === b.baseline?.of;

/** A trial in the planned order must be of a frozen task, a condition of the evaluation other than the baseline, and a repeat it has. */
function checkScheduled(state: EvaluationView, event: EvaluationEvent, trial: ScheduledTrial): void {
  if (!state.tasks.some((task) => task.id === trial.taskId)) throw new EvaluationLedgerInconsistentError(event, `task "${trial.taskId}" was never frozen`);
  if (!CONDITIONS.includes(trial.condition) || !state.conditions.includes(trial.condition)) throw new EvaluationLedgerInconsistentError(event, `condition ${trial.condition} is not one of this evaluation's`);
  if (trial.condition === "baseline" || trial.baseline !== null) throw new EvaluationLedgerInconsistentError(event, "a baseline trial is scheduled only once the C3 trial it matches has been scored");
  if (!Number.isSafeInteger(trial.repeat) || trial.repeat < 1 || trial.repeat > state.repeats) throw new EvaluationLedgerInconsistentError(event, `repeat ${trial.repeat} is not one of this evaluation's ${state.repeats}`);
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
      repeats: event.repeats,
      safeguards: event.safeguards ?? { spendCap: null, maxIncidentRate: null, toolVersions: null },
      spend: null,
      seed: null,
      pending: null,
      baselines: [],
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
      if (state.pending !== null) throw new EvaluationLedgerInconsistentError(event, "a task was frozen after the trials were scheduled");
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
    case "trials_scheduled":
      if (state.pending !== null) throw new EvaluationLedgerInconsistentError(event, "the trials are scheduled twice");
      for (const trial of event.order) checkScheduled(state, event, trial);
      state.seed = event.seed;
      state.pending = [...event.order];
      return state;
    case "baseline_scheduled": {
      const matched = trial(event.forTrialId);
      if (!state.conditions.includes("baseline")) throw new EvaluationLedgerInconsistentError(event, "this evaluation has no matched-budget baseline");
      if (matched.condition !== "C3" || matched.ended?.outcome !== "scored") throw new EvaluationLedgerInconsistentError(event, "a baseline matches a scored C3 trial");
      if (event.taskId !== matched.taskId || event.repeat !== matched.repeat) throw new EvaluationLedgerInconsistentError(event, "a baseline is for the task and repeat of the trial it matches");
      if (event.trials !== matched.ended.attempts || event.positions.length !== event.trials) throw new EvaluationLedgerInconsistentError(event, "a baseline has one C0 trial for each attempt the C3 trial made");
      if (state.baselines.some((baseline) => baseline.forTrialId === event.forTrialId)) throw new EvaluationLedgerInconsistentError(event, `trial "${event.forTrialId}" has a baseline already`);
      const pending = state.pending!;
      event.positions.forEach((position, index) => {
        if (!Number.isSafeInteger(position) || position < 0 || position > pending.length) throw new EvaluationLedgerInconsistentError(event, `position ${position} is outside the trials still to start`);
        pending.splice(position, 0, { taskId: event.taskId, condition: "baseline", repeat: event.repeat, baseline: { forTrialId: event.forTrialId, index: index + 1, of: event.trials } });
      });
      state.baselines.push({ forTrialId: event.forTrialId, taskId: event.taskId, repeat: event.repeat, trials: event.trials });
      return state;
    }
    case "trial_started": {
      // A changed task ends the evaluation: nothing starts after it.
      if (state.taskChanges.length > 0) throw new EvaluationLedgerInconsistentError(event, "a trial started after a task changed");
      if (state.trials.some((candidate) => candidate.id === event.trialId)) throw new EvaluationLedgerInconsistentError(event, `trial "${event.trialId}" started twice`);
      // The order was recorded before any trial: each one that starts is the next of those still to start, and no other.
      const next = state.pending?.[0];
      if (!next) throw new EvaluationLedgerInconsistentError(event, "no trial is scheduled to start");
      const started: ScheduledTrial = { taskId: event.taskId, condition: event.condition, repeat: event.repeat, baseline: event.baseline };
      if (!isSameTrial(started, next)) throw new EvaluationLedgerInconsistentError(event, `the next trial scheduled is ${JSON.stringify(next)}, not ${JSON.stringify(started)}`);
      if (state.trials.some((candidate) => !candidate.ended)) throw new EvaluationLedgerInconsistentError(event, "a trial starts only once the one before it has ended");
      state.pending!.shift();
      state.trials.push({ id: event.trialId, taskId: event.taskId, condition: event.condition, repeat: event.repeat, baseline: event.baseline, startedAtSeq: event.seq, startedAt: event.time, tools: event.tools ?? [], endedAt: null, repo: event.repo, incident: null, ended: null });
      return state;
    }
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
      if (event.outcome !== "harness_incident" && found.incident) throw new EvaluationLedgerInconsistentError(event, "an incident was recorded for it, so it ends as one");
      if (event.outcome === "unscored" && !event.unscored) throw new EvaluationLedgerInconsistentError(event, "an unscored trial says why");
      found.ended = event;
      found.endedAt = event.time;
      if (event.mock) state.mock = true;
      return state;
    }
    case "spend_observed": {
      const found = trial(event.trialId);
      if (!found.ended) throw new EvaluationLedgerInconsistentError(event, "spend is observed once the trial has ended");
      if (!state.safeguards.spendCap) throw new EvaluationLedgerInconsistentError(event, "this evaluation has no spend cap");
      state.spend = { currency: event.currency, amount: event.amount, attemptsWithoutCost: event.attemptsWithoutCost };
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
