// The evaluation ledger: one hash-chained, append-only JSONL file per `ahp eval` invocation, written by the same
// `LedgerWriter` as a run's (one writer at a time, torn tails truncated). It records the frozen tasks before any trial,
// and each trial's start and end; everything about how a trial's run went is in that run's own ledger, which the
// trial's record points at. The closed lists below are like the run protocol's: a new value is a protocol change.

import type { ChainedEvent } from "../ledger/index.ts";
import type { FailureClass, PathChange, RunState, UnknownReason, UsageReport } from "../protocol/index.ts";

/**
 * The conditions an evaluation runs, named as the design does (`docs/design`, §7): C0 one coding agent doing the whole task
 * in one step; C1 the plan → implement → review pipeline passing plain text; C2 that pipeline with AHP's handoffs and no
 * acceptance checks or retry; C3 full AHP. `baseline` is the matched-budget baseline, which the design names beside the
 * conditions: for each scored C3 trial, as many independent C0 trials as attempts that trial made, a success if any passes.
 */
export const CONDITIONS = ["C0", "C1", "C2", "C3", "baseline"] as const;
export type ConditionId = (typeof CONDITIONS)[number];

/** Which trial of the matched-budget baseline: the scored C3 trial it matches, and which of that trial's `of` C0 trials it is. */
export interface BaselineSlot {
  forTrialId: string;
  index: number;
  of: number;
}

/** A trial still to start, in the order the evaluation starts them. */
export interface ScheduledTrial {
  taskId: string;
  condition: ConditionId;
  /** From 1. */
  repeat: number;
  /** Set for a trial of the matched-budget baseline only. */
  baseline: BaselineSlot | null;
}

/** What one attempt's tool reported using, labelled with its adapter: null when it reported nothing. */
export interface AttemptUsage {
  attemptId: string;
  adapter: string;
  reportedModel: string;
  usage: UsageReport | null;
}

/**
 * Lines of work, counted by `git diff --numstat` (added plus deleted; a binary file counts 0). `result` is the diff from the
 * fixture to the commit scored. `duplicated` is the work of attempts whose snapshot is not in the result's history (a failed
 * attempt, or one a review sent back): work done and then done again. `reverted` is the work of the attempts whose snapshot is
 * in it, beyond what the result shows: lines one step wrote and a later one changed again or took out (never below 0).
 */
export interface TrialWork {
  result: number;
  duplicated: number;
  reverted: number;
}

/**
 * How a trial ended, for the report.
 * - `scored`: the validators ran to a result on what the trial left: `pass` or `fail`. The only outcome that counts.
 * - `harness_incident`: an attempt of the trial's run is `unknown`, so what its agent did is not known and it may still be
 *   running; not scored, and reported apart.
 * - `unscored`: nothing to score, for a reason in `UNSCORED_REASONS`; reported apart, never a pass or a fail.
 * - `cancelled`: the evaluation was cancelled (Ctrl+C) while the trial ran.
 */
export const TRIAL_OUTCOMES = ["scored", "harness_incident", "unscored", "cancelled"] as const;
export type TrialOutcome = (typeof TRIAL_OUTCOMES)[number];

/**
 * Why a trial that was not a harness incident has no score.
 * - `validator_inconclusive`: a validator could not run to a result, twice (a missing install, a command that is not
 *   there, a process killed by a signal): it says nothing about the trial.
 * - `setup_failed`: the run ended `config_auth` or `rejected`, so no coding agent did the work: a login or a
 *   configuration problem of the evaluation's, not something a condition did.
 * - `harness_error`: AHP itself threw while running or scoring the trial.
 */
export const UNSCORED_REASONS = ["validator_inconclusive", "setup_failed", "harness_error"] as const;
export type UnscoredReason = (typeof UNSCORED_REASONS)[number];

/** A file of a task directory: its path relative to the directory, with `/` separators, and the SHA-256 of its bytes. */
export interface FrozenFile {
  path: string;
  sha256: string;
}

/** A file an evaluation kept outside its ledger, which the ledger names by its place and hash. */
export interface StoredFile {
  /** Relative to the evaluation's directory, with `/` separators. */
  path: string;
  sha256: string;
  bytes: number;
}

/** Whether a planted constraint held in the result: `inconclusive` when its check could not run. */
export type ConstraintOutcome = "held" | "violated" | "inconclusive";

/** The validators' result for a trial whose validators ran to a result. */
export interface TrialScore {
  /** `pass` exactly when the hidden tests passed and no protected path changed. Constraints are scored apart. */
  verdict: "pass" | "fail";
  /** `ran` is false when a protected path was changed, which fails the trial without running the tests. */
  tests: { command: string; exitCode: number | null; ran: boolean };
  /** The paths of the result that are, contain or lie under a protected path, and differ from the fixture. */
  protectedPathViolations: string[];
  constraints: { id: string; outcome: Exclude<ConstraintOutcome, "inconclusive"> }[];
}

/** What a trial kept: its configuration, what each agent was sent and printed, the result and the validators' evidence. */
export interface TrialArtifacts {
  config: StoredFile;
  /** What each attempt's agent process was sent (the prompt, or an ACP client's messages). */
  prompts: { attemptId: string; file: StoredFile }[];
  /** What each attempt's agent process printed on stdout, raw. */
  transcripts: { attemptId: string; file: StoredFile }[];
  /** Why something above could not be kept (a disk problem); null when everything that exists was kept. */
  problem: string | null;
  /** The trial run's own ledger, as it ended. */
  runLedger: StoredFile | null;
  /** The diff from the fixture to the result the validators scored. */
  patch: StoredFile | null;
  /** The validators' evidence: each command's output and each constraint's findings. */
  validation: StoredFile | null;
}

export type EvaluationEventBody =
  | {
      type: "evaluation_created";
      evaluationId: string;
      protocolVersion: string;
      suite: string;
      conditions: ConditionId[];
      /**
       * The retry budget C3's steps run with, as resolved (the suite's own, else the default of 2); the other conditions have no
       * retry budget. The agents of each trial, as requested, are in its configuration (`trial_started.config`).
       */
      retryBudget: number;
      /** How many trials each task gets under each condition. */
      repeats: number;
    }
  /**
   * The order the trials start in, recorded after the freeze and before the first trial: every task under every condition
   * but the baseline, once per repeat, in a Fisher-Yates shuffle drawn from mulberry32 seeded with `seed`. The same seed
   * resamples the paired comparisons.
   */
  | { type: "trials_scheduled"; seed: number; order: ScheduledTrial[] }
  /**
   * The matched-budget baseline of a scored C3 trial: `trials` C0 trials (the attempts it made), each put into the trials
   * still to start at the position in `positions`, in turn, drawn from the generator the shuffle drew from.
   */
  | { type: "baseline_scheduled"; forTrialId: string; taskId: string; repeat: number; trials: number; positions: number[] }
  /**
   * A task, frozen: the hash of its whole directory and of its hidden tests, and every file's hash. Every task is
   * frozen before any trial starts, and re-hashed before each trial.
   */
  | {
      type: "task_frozen";
      taskId: string;
      dir: string;
      /** Not `hash`: every ledger event has a `hash` of its own, which a body field of that name would be overwritten by. */
      taskHash: string;
      hiddenTestsHash: string;
      files: FrozenFile[];
      hiddenTests: string[];
      constraints: string[];
      seededDefects: string[];
    }
  /** Recorded before the trial's repository is made or its run started: always the first of the trials still to start. */
  | { type: "trial_started"; trialId: string; taskId: string; condition: ConditionId; repeat: number; baseline: BaselineSlot | null; repo: string; config: StoredFile }
  /** An attempt of the trial's run is unknown: recorded before the trial ends, and the trial is not scored. */
  | { type: "harness_incident"; trialId: string; attemptId: string; unknownReason: UnknownReason; detail: string }
  | {
      type: "trial_ended";
      trialId: string;
      outcome: TrialOutcome;
      /** Null when the run never got far enough to have one (AHP threw before it was created). */
      runId: string | null;
      runState: RunState | null;
      /** The failure class the run's failed step ended with, if it failed. */
      failureClass: FailureClass | null;
      /** True when any attempt ran on the mock adapter: the results are not evidence. */
      mock: boolean;
      attempts: number;
      /** The attempts beyond each step's first: retries of every kind, send-backs and `transient` ones among them. */
      retries: number;
      /** The run's wall time, from its creation to its end; null when it never ended. */
      wallTimeMs: number | null;
      /** What each attempt's tool reported using, never estimated. */
      usage: AttemptUsage[];
      /** Null when no result was validated (and so none is known). */
      work: TrialWork | null;
      unscored: { reason: UnscoredReason; detail: string } | null;
      /**
       * The commit the validators scored: the last snapshot the run made, or the fixture if it made none. `changed` is whether
       * it differs from the fixture at all: a result that changed nothing holds every planted constraint vacuously.
       */
      result: { commit: string; snapshot: boolean; changed: boolean } | null;
      score: TrialScore | null;
      artifacts: TrialArtifacts | null;
    }
  /**
   * A frozen task's directory no longer hashes as it did, or can no longer be read (`foundHash` null): no further trial is
   * started, and the task is never frozen again.
   */
  | { type: "task_changed"; taskId: string; frozenHash: string; foundHash: string | null; changed: { path: string; change: PathChange }[] }
  | { type: "evaluation_ended"; state: "completed" | "stopped" | "cancelled"; reason: string | null }
  /** The process that opened the ledger to write it found a torn tail and truncated it. */
  | { type: "ledger_truncated"; droppedBytes: number };

export type EvaluationEventType = EvaluationEventBody["type"];
export type EvaluationEvent = ChainedEvent<EvaluationEventBody>;
