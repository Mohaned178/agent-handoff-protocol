// The report: what an evaluation's ledger says, per condition, with the raw counts beside every rate. It compares
// nothing between conditions: that is for a later ticket's paired statistics, and a number here is never read as "better".

import type { FailureClass, PathChange } from "../protocol/index.ts";
import type { ConditionId, UnscoredReason } from "./events.ts";
import type { EvaluationState, EvaluationView } from "./replay.ts";

/**
 * How the run of a scored trial that failed ended: the failure class of its failed step, or, when no step failed,
 * `run_succeeded` (the run passed its own checks and the validators did not) or `run_failed` (it failed with no class).
 */
export type FailureOutcome = FailureClass | "run_succeeded" | "run_failed";

export interface ConditionReport {
  condition: ConditionId;
  /** Trials that ended, however they ended. */
  trials: number;
  /** The valid trials: the validators ran to a result. Only these are in the rates. */
  scored: number;
  passes: number;
  /** `passes` over `scored`; null when nothing was scored. */
  successRate: number | null;
  /**
   * The scored trials of tasks that plant at least one constraint, whose result changed something: the denominator of the
   * violation rate. A result that changed nothing holds every constraint vacuously (nothing was written to break one), so
   * counting it would lower the rate by failing to produce anything.
   */
  constraintTrials: number;
  /** Of those, the trials in which any planted constraint was violated. */
  constraintViolations: number;
  constraintViolationRate: number | null;
  /** The scored trials of tasks that plant a constraint whose result changed nothing, which `constraintTrials` leaves out. */
  unchangedResults: number;
  /** The scored trials that failed, by how their run ended. */
  failures: Partial<Record<FailureOutcome, number>>;
  /** Trials ended by an `unknown` attempt: excluded from every count above and reported apart (glossary: harness incident). */
  harnessIncidents: { count: number; trials: { trialId: string; taskId: string; attemptId: string; reason: string; detail: string }[] };
  /** Trials with nothing to score, by reason: excluded as well, and never counted as a pass or a fail. */
  unscored: { count: number; byReason: Partial<Record<UnscoredReason, number>>; trials: { trialId: string; taskId: string; reason: UnscoredReason; detail: string }[] };
  cancelled: number;
}

export interface EvaluationReport {
  evaluationId: string;
  suite: string;
  state: EvaluationState;
  reason: string | null;
  /** True when any trial ran on the mock adapter: nothing in the report is evidence. */
  mock: boolean;
  conditions: ConditionReport[];
  taskChanges: { taskId: string; frozenHash: string; foundHash: string | null; changed: { path: string; change: PathChange }[] }[];
}

const rateOf = (part: number, whole: number) => (whole === 0 ? null : part / whole);

export function reportOf(view: EvaluationView): EvaluationReport {
  const constrained = new Set(view.tasks.filter((task) => task.constraints.length > 0).map((task) => task.id));
  const conditions = view.conditions.map((condition): ConditionReport => {
    const ended = view.trials.filter((trial) => trial.condition === condition && trial.ended);
    const scored = ended.filter((trial) => trial.ended!.outcome === "scored");
    const passes = scored.filter((trial) => trial.ended!.score!.verdict === "pass");
    const withConstraints = scored.filter((trial) => constrained.has(trial.taskId));
    const constrainedTrials = withConstraints.filter((trial) => trial.ended!.result!.changed);
    const violating = constrainedTrials.filter((trial) => trial.ended!.score!.constraints.some((constraint) => constraint.outcome === "violated"));
    const failures: Partial<Record<FailureOutcome, number>> = {};
    for (const trial of scored) {
      if (trial.ended!.score!.verdict !== "fail") continue;
      const how: FailureOutcome = trial.ended!.failureClass ?? (trial.ended!.runState === "succeeded" ? "run_succeeded" : "run_failed");
      failures[how] = (failures[how] ?? 0) + 1;
    }
    const incidents = ended.filter((trial) => trial.ended!.outcome === "harness_incident");
    const unscored = ended.filter((trial) => trial.ended!.outcome === "unscored");
    const byReason: Partial<Record<UnscoredReason, number>> = {};
    for (const trial of unscored) byReason[trial.ended!.unscored!.reason] = (byReason[trial.ended!.unscored!.reason] ?? 0) + 1;
    return {
      condition,
      trials: ended.length,
      scored: scored.length,
      passes: passes.length,
      successRate: rateOf(passes.length, scored.length),
      constraintTrials: constrainedTrials.length,
      constraintViolations: violating.length,
      constraintViolationRate: rateOf(violating.length, constrainedTrials.length),
      unchangedResults: withConstraints.length - constrainedTrials.length,
      failures,
      harnessIncidents: {
        count: incidents.length,
        trials: incidents.map((trial) => ({ trialId: trial.id, taskId: trial.taskId, attemptId: trial.incident!.attemptId, reason: trial.incident!.unknownReason, detail: trial.incident!.detail })),
      },
      unscored: {
        count: unscored.length,
        byReason,
        trials: unscored.map((trial) => ({ trialId: trial.id, taskId: trial.taskId, reason: trial.ended!.unscored!.reason, detail: trial.ended!.unscored!.detail })),
      },
      cancelled: ended.filter((trial) => trial.ended!.outcome === "cancelled").length,
    };
  });
  return {
    evaluationId: view.evaluationId,
    suite: view.suite,
    state: view.state,
    reason: view.reason,
    mock: view.mock,
    conditions,
    taskChanges: view.taskChanges.map(({ taskId, frozenHash, foundHash, changed }) => ({ taskId, frozenHash, foundHash, changed })),
  };
}

export const MOCK_REPORT_NOTE = "These results come from the mock adapter. They are labelled [mock] and are not evidence.";

const CONDITION_NAMES: Record<ConditionId, string> = { C0: "single agent", C3: "full AHP" };

/** `n of d (p%)`, or why there is no rate. */
const ratio = (part: number, whole: number, what: string) =>
  whole === 0 ? `n/a: no ${what}` : `${part} of ${whole} ${what} (${Math.round((100 * part) / whole)}%)`;

/** The report as text for a person: rates always with their counts, exclusions always shown, and no comparison drawn. */
export function formatReport(report: EvaluationReport): string {
  const lines = [`Evaluation ${report.evaluationId}: suite "${report.suite}", ${report.state}${report.reason ? ` (${report.reason})` : ""}`];
  if (report.mock) lines.push(`[mock] ${MOCK_REPORT_NOTE}`);
  for (const change of report.taskChanges) {
    const found = change.foundHash === null ? "no longer readable" : `now hashes ${change.foundHash.slice(0, 12)}`;
    lines.push(`TASK CHANGED: "${change.taskId}" was frozen as ${change.frozenHash.slice(0, 12)} and ${found}; no further trial was started.`);
    for (const { path, change: how } of change.changed) lines.push(`  ${how}: ${path}`);
  }
  for (const condition of report.conditions) {
    lines.push("", `${condition.condition} (${CONDITION_NAMES[condition.condition]}): ${condition.trials} trial${condition.trials === 1 ? "" : "s"}`);
    lines.push(`  verified success: ${ratio(condition.passes, condition.scored, "scored trials")}`);
    lines.push(`  constraint violations: ${ratio(condition.constraintViolations, condition.constraintTrials, "scored trials of tasks with planted constraints")}`);
    if (condition.unchangedResults > 0) lines.push(`  scored trials whose result changed nothing, left out of the violation rate: ${condition.unchangedResults}`);
    const failed = Object.entries(condition.failures);
    if (failed.length > 0) lines.push(`  failed trials by how their run ended: ${failed.map(([how, count]) => `${how} ${count}`).join(", ")}`);
    lines.push(`  harness incidents (excluded, not failures): ${condition.harnessIncidents.count}`);
    for (const incident of condition.harnessIncidents.trials) lines.push(`    ${incident.taskId}: attempt ${incident.attemptId} unknown (${incident.reason}): ${incident.detail}`);
    lines.push(`  unscored (excluded, not failures): ${condition.unscored.count}`);
    for (const trial of condition.unscored.trials) lines.push(`    ${trial.taskId}: ${trial.reason}: ${trial.detail}`);
    if (condition.cancelled > 0) lines.push(`  cancelled: ${condition.cancelled}`);
  }
  lines.push("", "Rates count only scored trials. This report draws no comparison between conditions.");
  return lines.join("\n");
}
