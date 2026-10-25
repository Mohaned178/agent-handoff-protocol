import { randomBytes } from "node:crypto";
import type { Adapter } from "../adapters/index.ts";
import { applyEvent, LedgerWriter } from "../ledger/index.ts";
import {
  PROTOCOL_VERSION,
  type EvidenceItem,
  type LedgerEvent,
  type LedgerEventBody,
  type RunView,
  type StepDefinition,
  type ValidatorStage,
  type WorkflowDefinition,
} from "../protocol/index.ts";
import { git } from "./git.ts";
import { introduceHiddenTests } from "./hidden-tests.ts";
import { buildHandoff, validateHandoffRevision } from "./handoff.ts";
import { ledgerPath, locateRepo, prepareWorktreeRoot, snapshotRef, worktreePath, type RepoLocation } from "./paths.ts";
import { changedPaths, checkProtectedPaths, diffScopeEvidence } from "./scope.ts";
import { checkRequiredOutputFields, installDependencies, runVerificationCommand, validatorError, verdictOf } from "./verification.ts";
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
    for (const [index, step] of workflow.steps.entries()) {
      const stepSucceeded = await executeStep(step, index, {
        runId,
        baseCommit,
        location,
        worktreeRoot,
        adapters: options.adapters,
        workflow,
        state: () => state!,
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
  workflow: WorkflowDefinition;
  /** The state derived from the ledger so far. */
  state: () => Readonly<RunView>;
  record: (body: LedgerEventBody) => Promise<void>;
}

/**
 * Issues the step's handoff, has it validated on the recipient's behalf, and, once accepted, runs one attempt
 * and verifies it. Returns whether the step succeeded.
 */
async function executeStep(step: StepDefinition, index: number, context: StepContext): Promise<boolean> {
  const { runId, baseCommit: runBaseCommit, location, worktreeRoot, record } = context;
  const adapter = context.adapters.get(step.agent.adapter);
  if (!adapter) throw new Error(`step "${step.id}" names unknown adapter "${step.agent.adapter}"`);

  await record({ type: "step_ready", stepId: step.id });

  // The previous step has succeeded, so its last attempt is the verified one whose result is handed on, and
  // its snapshot is the recipient's starting point: the work so far, including every artifact it passes.
  const senderAttempt = index > 0 ? context.state().steps[index - 1]?.attempts.at(-1) : undefined;
  const base = senderAttempt?.snapshot?.commit ?? runBaseCommit;
  const handoff = await buildHandoff({
    repo: location.repo,
    runId,
    handoffId: newId("hnd"),
    step,
    sender: senderAttempt
      ? { step: context.workflow.steps[index - 1]!, attemptId: senderAttempt.id, reportedOutput: senderAttempt.reportedOutput }
      : null,
    baseCommit: base,
  });
  await record({ type: "handoff_issued", handoff });
  // Validate the document as a recipient would receive it, not the object the runtime built.
  const validation = await validateHandoffRevision(JSON.parse(JSON.stringify(handoff)), location.repo);
  if (!validation.accepted) {
    const { handoffId, revision } = handoff;
    await record({ type: "handoff_rejected", handoffId, revision, reasons: validation.reasons });
    await record({ type: "step_terminal", stepId: step.id, state: "failed", failureClass: "rejected" });
    return false;
  }
  await record({ type: "handoff_accepted", handoffId: handoff.handoffId, revision: handoff.revision });

  const attemptId = newId("att");
  const workspace = worktreePath(worktreeRoot, runId, attemptId);
  await record({
    type: "attempt_created",
    stepId: step.id,
    attemptId,
    handoffId: handoff.handoffId,
    handoffRevision: handoff.revision,
    adapter: adapter.declaration.name,
    mock: adapter.declaration.mock,
    requestedModel: step.agent.model ?? null,
    workspace,
  });
  await addWorktree(location.repo, workspace, base);

  await record({ type: "attempt_dispatching", attemptId });
  const started = await adapter.startAttempt({
    attemptId,
    attemptNumber: 1,
    workspace,
    requestedModel: step.agent.model ?? null,
    handoff: validation.handoff,
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
  const evidence: EvidenceItem[] = [];
  // Whether the attempt stayed out of the protected paths is known before anything runs. A violation fails
  // verification whatever the command says, so the command, which would run the attempt's changes to the test
  // runner and scripts, is not run. If the check itself cannot be made, the command is not run either.
  const hiddenTests = step.verification.hiddenTests ?? [];
  const protectedPaths = [...new Set([...(step.verification.protectedPaths ?? []), ...hiddenTests.map((test) => test.path)])];
  let scopeSettled = true;
  if (protectedPaths.length > 0) {
    try {
      const changed = await changedPaths(location.repo, base, snapshot);
      const check = checkProtectedPaths(changed, protectedPaths);
      evidence.push(diffScopeEvidence(changed), check);
      scopeSettled = check.violations.length === 0;
    } catch (error) {
      evidence.push(validatorError("diff_scope", error));
      scopeSettled = false;
    }
  }
  // A structural verification runs no command, so it needs no verification worktree.
  const command = step.verification.command;
  const commandRun =
    command === undefined || !scopeSettled ? null : { command, worktree: worktreePath(worktreeRoot, runId, verificationId) };
  await record({
    type: "verification_started",
    attemptId,
    verificationId,
    command: command ?? null,
    worktree: commandRun?.worktree ?? null,
  });
  if (commandRun) {
    // Whatever breaks on AHP's side from here on is evidence that the validator could not run, not a verdict on
    // the attempt, and a verdict is always recorded.
    let stage: ValidatorStage = "verification_worktree";
    let created = false;
    try {
      await addWorktree(location.repo, commandRun.worktree, snapshot);
      created = true;
      if (step.verification.install !== undefined) {
        stage = "install";
        await installDependencies(step.verification.install, commandRun.worktree);
      }
      stage = "hidden_tests";
      await introduceHiddenTests(commandRun.worktree, hiddenTests);
      stage = "command";
      evidence.push(await runVerificationCommand(commandRun.command, commandRun.worktree));
    } catch (error) {
      evidence.push(validatorError(stage, error));
    } finally {
      if (created) await removeWorktree(location.repo, commandRun.worktree);
    }
  }
  const requiredFields = step.verification.requiredOutputFields ?? [];
  if (requiredFields.length > 0) evidence.push(checkRequiredOutputFields(requiredFields, exit.reportedOutput));
  const verdict = verdictOf(evidence);
  await record({ type: "verification_verdict", verificationId, verdict, evidence });

  const passed = verdict === "pass";
  await record({
    type: "step_terminal",
    stepId: step.id,
    state: passed ? "succeeded" : "failed",
    failureClass: passed ? null : verdict === "inconclusive" ? "inconclusive" : "verification_failed",
  });
  return passed;
}
