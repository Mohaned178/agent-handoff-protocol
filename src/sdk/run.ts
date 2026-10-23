import { access } from "node:fs/promises";
import { adapters } from "../adapters/index.ts";
import { readLedger, replay } from "../ledger/index.ts";
import type { LedgerEvent, RunView, WorkflowDefinition } from "../protocol/index.ts";
import { executeRun, isRunId, ledgerPath, locateRepo, type RunResult } from "../runtime/index.ts";
import { defineWorkflow } from "./workflow.ts";

export interface RunWorkflowOptions {
  /** Any directory inside the git repository to run against. Its HEAD commit is the run's base. */
  repo: string;
  /** Called after each event is durably recorded in the ledger, with the state derived so far. */
  onEvent?: (event: LedgerEvent, state: Readonly<RunView>) => void;
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

/** Reads a run's ledger events in append order. */
export async function readRunEvents({ repo, runId }: ReadRunOptions): Promise<LedgerEvent[]> {
  if (!isRunId(runId)) throw new Error(`not a run ID: ${runId}`);
  const location = await locateRepo(repo);
  const path = ledgerPath(location, runId);
  try {
    await access(path);
  } catch {
    throw new Error(`no run ${runId} in ${location.repo}`);
  }
  return readLedger(path);
}
