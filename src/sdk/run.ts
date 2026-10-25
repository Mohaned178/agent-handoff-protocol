import { access } from "node:fs/promises";
import { adapters } from "../adapters/index.ts";
import { lockPathOf, readCheckedLedger, readLockState, replay, type LockState } from "../ledger/index.ts";
import type { LedgerEvent, RunView, WorkflowDefinition } from "../protocol/index.ts";
import { executeRun, isRunId, ledgerPath, locateRepo, type Clock, type RunResult } from "../runtime/index.ts";
import { defineWorkflow } from "./workflow.ts";

export interface RunWorkflowOptions {
  /** Any directory inside the git repository to run against. Its HEAD commit is the run's base. */
  repo: string;
  /** Called after each event is durably recorded in the ledger, with the state derived so far. */
  onEvent?: (event: LedgerEvent, state: Readonly<RunView>) => void;
  /** Stamps ledger events and waits out a retry's backoff; defaults to the system clock. Tests pass one that never waits. */
  clock?: Clock;
}

/** Validates and runs a workflow to a terminal state; resolves with the run ID and its derived state. */
export async function runWorkflow(workflow: WorkflowDefinition, options: RunWorkflowOptions): Promise<RunResult> {
  return executeRun(defineWorkflow(workflow), { ...options, adapters });
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

async function runLedgerPath({ repo, runId }: ReadRunOptions): Promise<string> {
  if (!isRunId(runId)) throw new Error(`not a run ID: ${runId}`);
  const location = await locateRepo(repo);
  const path = ledgerPath(location, runId);
  try {
    await access(path);
  } catch {
    throw new Error(`no run ${runId} in ${location.repo}`);
  }
  return path;
}
