import type { EvaluationEvent, EvaluationView, TrialView } from "../evaluation/index.ts";
import { money } from "../evaluation/report.ts";

const mockTag = (isMock: boolean) => (isMock ? " [mock]" : "");

/** A trial by condition, task and repeat, as the progress lines name it. */
const labelOf = (trial: TrialView | undefined) => (trial ? `trial ${trial.condition} ${trial.taskId} #${trial.repeat}` : "a trial");

/** One progress line for an event `ahp eval` has just recorded, with the state derived so far to name the trial it belongs to. */
export function formatEvaluationEvent(event: EvaluationEvent, state: Readonly<EvaluationView>): string {
  const trial = (id: string) => state.trials.find((candidate) => candidate.id === id);
  const label = (id: string) => {
    const found = trial(id);
    if (!found) return `trial ${id}`;
    return found.baseline ? `${labelOf(found)} (${found.baseline.index} of ${found.baseline.of} for ${labelOf(trial(found.baseline.forTrialId))})` : labelOf(found);
  };
  switch (event.type) {
    case "evaluation_created":
      return `evaluation ${event.evaluationId}: suite "${event.suite}", conditions ${event.conditions.join(", ")}, ${event.repeats} repeat${event.repeats === 1 ? "" : "s"}`;
    case "trials_scheduled":
      return `${event.order.length} trial${event.order.length === 1 ? "" : "s"} scheduled in a shuffled order (seed ${event.seed})`;
    case "baseline_scheduled":
      return `baseline for ${labelOf(trial(event.forTrialId))}: ${event.trials} C0 trial${event.trials === 1 ? "" : "s"} scheduled, one for each attempt it made`;
    case "task_frozen":
      return `task ${event.taskId} frozen (${event.taskHash.slice(0, 12)}): ${event.files.length} files, ${event.hiddenTests.length} hidden test${event.hiddenTests.length === 1 ? "" : "s"}`;
    case "trial_started": {
      const mismatched = event.tools.filter((tool) => tool.matches === false);
      const warning = mismatched.map((tool) => ` VERSION MISMATCH: ${tool.tool} is ${tool.found ?? `unreadable (${tool.problem})`}, the suite pins ${tool.pinned}`).join(";");
      return `${label(event.trialId)}: started${warning}`;
    }
    case "spend_observed":
      return `reported spend so far: ${money(event.amount)} ${event.currency}${event.attemptsWithoutCost > 0 ? ` (${event.attemptsWithoutCost} attempt${event.attemptsWithoutCost === 1 ? "" : "s"} reported no cost in it)` : ""}`;
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
