import { randomBytes } from "node:crypto";
import type { Adapter } from "../adapters/index.ts";
import { applyEvent, LedgerWriter } from "../ledger/index.ts";
import {
  PROTOCOL_VERSION,
  type LedgerEvent,
  type LedgerEventBody,
  type RunView,
  type StepDefinition,
  type WorkflowDefinition,
} from "../protocol/index.ts";
import { git } from "./git.ts";
import { ledgerPath, locateRepo, prepareWorktreeRoot, snapshotRef, worktreePath, type RepoLocation } from "./paths.ts";
import { runVerificationCommand } from "./verification.ts";
import { addWorktree, removeWorktree, snapshotWorktree } from "./workspace.ts";

export interface ExecuteRunOptions {
  /** Any directory inside the git repository to run against. */
  repo: string;
  adapters: ReadonlyMap<string, Adapter>;
  /** Called after each event is durably recorded, with the state derived so far. */
  onEvent?: (event: LedgerEvent, state: Readonly<RunView>) => void;
}

export interface RunResult {
  runId: string;
  state: RunView;
}

/** Short, sortable, lowercase IDs that are safe in paths and git ref names. */
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

/**
 * Executes a validated workflow against a repository. Every event is recorded in the run's ledger
 * before the effect it announces happens, and the returned state is derived from those events alone.
 */
export async function executeRun(workflow: WorkflowDefinition, options: ExecuteRunOptions): Promise<RunResult> {
  const location = await locateRepo(options.repo);
  const baseCommit = await git(location.repo, ["rev-parse", "--verify", "HEAD^{commit}"]).catch((error) => {
    throw new Error(`${location.repo} has no commits to run against`, { cause: error });
  });
  const worktreeRoot = await prepareWorktreeRoot();
  const runId = newId("run");
  const ledger = await LedgerWriter.create(ledgerPath(location, runId));
  let state: RunView | undefined;
  const record = async (body: LedgerEventBody): Promise<void> => {
    const event = await ledger.append(body);
    state = applyEvent(state, event);
    options.onEvent?.(event, state);
  };

  try {
    await record({
      type: "run_created",
      runId,
      protocolVersion: PROTOCOL_VERSION,
      workflow,
      repo: location.repo,
      baseCommit,
    });
    await record({ type: "run_started" });

    let runSucceeded = true;
    for (const step of workflow.steps) {
      const stepSucceeded = await executeStep(step, {
        runId,
        baseCommit,
        location,
        worktreeRoot,
        adapters: options.adapters,
        record,
      });
      if (!stepSucceeded) {
        runSucceeded = false;
        break;
      }
    }
    await record({ type: "run_terminal", state: runSucceeded ? "succeeded" : "failed" });
  } finally {
    await ledger.close();
  }
  return { runId, state: state! };
}

interface StepContext {
  runId: string;
  baseCommit: string;
  location: RepoLocation;
  worktreeRoot: string;
  adapters: ReadonlyMap<string, Adapter>;
  record: (body: LedgerEventBody) => Promise<void>;
}

/** Runs one attempt of `step` and verifies it; returns whether the step succeeded. */
async function executeStep(step: StepDefinition, context: StepContext): Promise<boolean> {
  const { runId, baseCommit, location, worktreeRoot, record } = context;
  const adapter = context.adapters.get(step.agent.adapter);
  if (!adapter) throw new Error(`step "${step.id}" names unknown adapter "${step.agent.adapter}"`);

  await record({ type: "step_ready", stepId: step.id });

  const attemptId = newId("att");
  const workspace = worktreePath(worktreeRoot, runId, attemptId);
  await record({
    type: "attempt_created",
    stepId: step.id,
    attemptId,
    adapter: adapter.declaration.name,
    mock: adapter.declaration.mock,
    requestedModel: step.agent.model ?? null,
    workspace,
  });
  await addWorktree(location.repo, workspace, baseCommit);

  await record({ type: "attempt_dispatching", attemptId });
  const started = await adapter.startAttempt({
    attemptId,
    attemptNumber: 1,
    workspace,
    requestedModel: step.agent.model ?? null,
    options: step.agent.options,
  });
  await record({ type: "attempt_running", attemptId, pid: started.pid });
  const exit = await started.exited;
  const outcome = exit.exitCode === 0 ? "ok" : "error";
  await record({ type: "attempt_exited", attemptId, outcome, ...exit });

  const ref = snapshotRef(runId, attemptId);
  const snapshot = await snapshotWorktree(workspace, ref, `AHP snapshot of ${runId} step ${step.id} attempt ${attemptId}`);
  await record({ type: "workspace_snapshot_committed", attemptId, commit: snapshot, ref });

  if (outcome !== "ok") {
    await record({ type: "step_terminal", stepId: step.id, state: "failed", failureClass: "agent_error" });
    return false;
  }

  const verificationId = newId("ver");
  const verificationWorktree = worktreePath(worktreeRoot, runId, verificationId);
  await record({
    type: "verification_started",
    attemptId,
    verificationId,
    command: step.verification.command,
    worktree: verificationWorktree,
  });
  await addWorktree(location.repo, verificationWorktree, snapshot);
  let result;
  try {
    result = await runVerificationCommand(step.verification.command, verificationWorktree);
  } finally {
    await removeWorktree(location.repo, verificationWorktree);
  }
  await record({ type: "verification_verdict", verificationId, verdict: result.verdict, evidence: [result.evidence] });

  const passed = result.verdict === "pass";
  await record({
    type: "step_terminal",
    stepId: step.id,
    state: passed ? "succeeded" : "failed",
    failureClass: passed ? null : "verification_failed",
  });
  return passed;
}
