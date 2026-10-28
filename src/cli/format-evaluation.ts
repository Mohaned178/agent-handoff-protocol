import type { EvaluationEvent, EvaluationView } from "../evaluation/index.ts";

const mockTag = (isMock: boolean) => (isMock ? " [mock]" : "");

/** One progress line for an event `ahp eval` has just recorded, with the state derived so far to name the trial it belongs to. */
export function formatEvaluationEvent(event: EvaluationEvent, state: Readonly<EvaluationView>): string {
  const trial = (id: string) => state.trials.find((candidate) => candidate.id === id);
  const label = (id: string) => {
    const found = trial(id);
    return found ? `trial ${found.condition} ${found.taskId}` : `trial ${id}`;
  };
  switch (event.type) {
    case "evaluation_created":
      return `evaluation ${event.evaluationId}: suite "${event.suite}", conditions ${event.conditions.join(", ")}`;
    case "task_frozen":
      return `task ${event.taskId} frozen (${event.taskHash.slice(0, 12)}): ${event.files.length} files, ${event.hiddenTests.length} hidden test${event.hiddenTests.length === 1 ? "" : "s"}`;
    case "trial_started":
      return `${label(event.trialId)}: started`;
    case "harness_incident":
      return `${label(event.trialId)}: attempt ${event.attemptId} is unknown (${event.unknownReason})`;
    case "trial_ended": {
      switch (event.outcome) {
        case "scored":
          return `${label(event.trialId)}: scored, ${event.score!.verdict}${mockTag(event.mock)}`;
        case "harness_incident":
          return `${label(event.trialId)}: harness incident, not scored${mockTag(event.mock)}`;
        case "unscored":
          return `${label(event.trialId)}: not scored${mockTag(event.mock)} (${event.unscored!.reason}): ${event.unscored!.detail}`;
        case "cancelled":
          return `${label(event.trialId)}: cancelled${mockTag(event.mock)}`;
      }
    }
    case "task_changed":
      return `task ${event.taskId} CHANGED since it was frozen: no further trial will start`;
    case "evaluation_ended":
      return `evaluation ${event.state}${mockTag(state.mock)}${event.reason ? `: ${event.reason}` : ""}`;
    case "ledger_truncated":
      return `the evaluation's ledger ended in a torn tail of ${event.droppedBytes} bytes, which was truncated`;
  }
}
