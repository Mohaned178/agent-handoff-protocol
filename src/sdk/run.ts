import { adapters } from "../adapters/index.ts";
import { lockPathOf, readCheckedLedger, readLockState, replay, type LockState } from "../ledger/index.ts";
import type { LedgerEvent, RecoveryAction, RunView, WorkflowDefinition } from "../protocol/index.ts";
import {
  executeRun,
  locateRun,
  recoverAttempt as recoverAttemptInRuntime,
  resumeRun as resumeRunInRuntime,
  type Clock,
  type ResumeResult,
  type RunResult,
} from "../runtime/index.ts";
import { defineWorkflow } from "./workflow.ts";

export interface RunWorkflowOptions {
  /** Any directory inside the git repository to run against. Its HEAD commit is the run's base. */
  repo: string;
  /** Called after each event is durably recorded in the ledger, with the state derived so far. */
  onEvent?: (event: LedgerEvent, state: Readonly<RunView>) => void;
  /** Stamps ledger events and waits out a retry's backoff; defaults to the system clock. Tests pass one that never waits. */
  clock?: Clock;
}

/**
 * Validates and runs a workflow until it ends, or until it stops for a person (`needs_recovery`); resolves with the
 * run ID and its derived state.
 */
export async function runWorkflow(workflow: WorkflowDefinition, options: RunWorkflowOptions): Promise<RunResult> {
  return executeRun(defineWorkflow(workflow), { ...options, adapters });
}

export interface ResumeRunOptions extends RunWorkflowOptions {
  runId: string;
}

/**
 * Continues a run whose process stopped before it ended, from where its ledger says it got to, taking over the
 * stale lock that process left; resolves once the run ends or stops for a person again. An attempt that was
 * dispatched and has no record of how it ended is never dispatched again: it becomes `unknown`. A run that ended or
 * awaits a decision is left as it is (`resumed: false`). Throws `LedgerLockedError` if a running process holds it.
 */
export async function resumeRun(options: ResumeRunOptions): Promise<ResumeResult> {
  return resumeRunInRuntime({ ...options, adapters });
}

export interface RecoverAttemptOptions extends RunWorkflowOptions {
  /** An attempt whose outcome is unknown and whose run stopped for a decision. */
  attemptId: string;
  /** `adopt` verifies the attempt's workspace as its result; `abort` ends its step. */
  policy: RecoveryAction;
}

/**
 * Decides an attempt that awaits recovery and resumes its run, until the run ends or stops again. Throws
 * `RecoveryRefusedError`, writing nothing, unless the attempt awaits a decision; `LedgerLockedError` if a running
 * process holds the run.
 */
export async function recoverAttempt(options: RecoverAttemptOptions): Promise<RunResult> {
  return recoverAttemptInRuntime({ ...options, adapters });
}

export interface ReadRunOptions {
  repo: string;
  runId: string;
}

/** Derives a run's current state by replaying its ledger. */
export async function readRun(options: ReadRunOptions): Promise<RunView> {
  return replay(await readRunEvents(options));
}

/**
 * Reads a run's ledger events in append order, each checked against its sequence number and the hash chain.
 * Throws `LedgerCorruptError` if the chain is broken anywhere. A last line that a write did not finish is not
 * part of the run and is left out.
 */
export async function readRunEvents(options: ReadRunOptions): Promise<LedgerEvent[]> {
  return (await readCheckedLedger(await runLedgerPath(options))).events;
}

/** A run's state together with what its ledger file and lock say about how far it can be trusted. */
export interface RunInspection {
  /** Derived from the ledger's events, every one checked against the hash chain. */
  state: RunView;
  ledger: {
    /** How many events the ledger holds. */
    events: number;
    /**
     * A last line that a write did not finish, left out of `state`. While a writer holds the lock it may be an
     * event being written at this moment; otherwise the next process to open the run for writing truncates it.
     */
    tornTail: { bytes: number } | null;
  };
  /** The run's ledger lock: free, or naming the process writing the run or one that stopped without releasing it. */
  lock: LockState;
}

/**
 * Derives a run's state and says who is writing the run and whether its ledger ends in a torn tail. Throws
 * `LedgerCorruptError` if the hash chain is broken, rather than return state that cannot be trusted.
 */
export async function inspectRun(options: ReadRunOptions): Promise<RunInspection> {
  const path = await runLedgerPath(options);
  // The lock before the ledger: a writer that releases it in between has already recorded its last event.
  const lock = await readLockState(lockPathOf(path));
  const read = await readCheckedLedger(path);
  return { state: replay(read.events), ledger: { events: read.events.length, tornTail: read.tornTail }, lock };
}

const runLedgerPath = async ({ repo, runId }: ReadRunOptions) => (await locateRun(repo, runId)).path;
