import { randomBytes } from "node:crypto";
import type { Adapter } from "../adapters/index.ts";
import { applyEvent, LedgerWriter } from "../ledger/index.ts";
import {
  PROTOCOL_VERSION,
  type AgentRef,
  type EvidenceItem,
  type FailureClass,
  type HandoffRevision,
  type LedgerEvent,
  type LedgerEventBody,
  type RunView,
  type StepDefinition,
  type ValidatorStage,
  type VerificationState,
  type WorkflowDefinition,
} from "../protocol/index.ts";
import { systemClock, type Clock } from "./clock.ts";
import { classifyAttempt, decideAfterFailure, resolveRetryPolicy } from "./failure.ts";
import { git } from "./git.ts";
import { introduceHiddenTests } from "./hidden-tests.ts";
import { buildHandoff, retryEvidence, reviseHandoff, validateHandoffRevision } from "./handoff.ts";
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
  /** Stamps ledger events and waits out a retry's backoff. Defaults to the system clock. */
  clock?: Clock;
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
  const clock = options.clock ?? systemClock;
  const runId = newId("run");
  const ledger = await LedgerWriter.create(ledgerPath(location, runId), () => clock.now());
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
        clock,
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
  clock: Clock;
  /** The state derived from the ledger so far. */
  state: () => Readonly<RunView>;
  record: (body: LedgerEventBody) => Promise<void>;
}

function adapterFor(step: StepDefinition, agent: AgentRef, context: StepContext): Adapter {
  const adapter = context.adapters.get(agent.adapter);
  if (!adapter) throw new Error(`step "${step.id}" names unknown adapter "${agent.adapter}"`);
  return adapter;
}

/**
 * Runs a step to its end: issues its handoff and has it validated on the recipient's behalf, then runs attempts,
 * each verified, until one passes or the failure policy says to stop. Every retry is a new attempt in a new
 * workspace made from the step's base commit; what is left of the retry budgets is read from the ledger's replay,
 * never kept in memory. Returns whether the step succeeded.
 */
async function executeStep(step: StepDefinition, index: number, context: StepContext): Promise<boolean> {
  const { runId, baseCommit: runBaseCommit, location, record } = context;
  // Every agent the step may use must exist before anything is recorded.
  let agent = step.agent;
  adapterFor(step, agent, context);
  if (step.reroute) adapterFor(step, step.reroute, context);

  await record({ type: "step_ready", stepId: step.id });

  // The previous step has succeeded, so its last attempt is the verified one whose result is handed on, and
  // its snapshot is the recipient's starting point: the work so far, including every artifact it passes.
  const senderAttempt = index > 0 ? context.state().steps[index - 1]?.attempts.at(-1) : undefined;
  // Every attempt of this step, retries included, starts from this commit, so a failed attempt's files never leak.
  const base = senderAttempt?.snapshot?.commit ?? runBaseCommit;
  let issuing: HandoffRevision | null = await buildHandoff({
    repo: location.repo,
    runId,
    handoffId: newId("hnd"),
    step,
    sender: senderAttempt
      ? { step: context.workflow.steps[index - 1]!, attemptId: senderAttempt.id, reportedOutput: senderAttempt.reportedOutput }
      : null,
    baseCommit: base,
  });
  let accepted: HandoffRevision | null = null;
  const policy = resolveRetryPolicy(step.retry);

  for (;;) {
    if (issuing) {
      accepted = await issueHandoff(step, issuing, context);
      if (!accepted) return false;
      issuing = null;
    }
    const attempt = await executeAttempt(step, index, agent, accepted!, base, context);
    if (attempt.failureClass === null) {
      await record({ type: "step_terminal", stepId: step.id, state: "succeeded", failureClass: null });
      return true;
    }

    const decision = decideAfterFailure({
      failureClass: attempt.failureClass,
      policy,
      usage: context.state().steps[index]!.retryUsage,
      validatorRuns: attempt.validatorRuns,
      reroute: step.reroute !== undefined,
    });
    switch (decision.action) {
      case "stop":
        await record({ type: "step_terminal", stepId: step.id, state: "failed", failureClass: attempt.failureClass });
        return false;
      case "rerun_validator":
        // The validator is re-run inside the attempt, so a failure that reaches here is already final.
        throw new Error(`step "${step.id}": a validator re-run was decided after its attempt ended`);
      case "retry": {
        await record({
          type: "retry_scheduled",
          stepId: step.id,
          attemptId: attempt.attemptId,
          failureClass: attempt.failureClass,
          change: decision.input === "changed" ? "evidence" : "none",
          delayMs: decision.delayMs,
        });
        if (decision.delayMs > 0) await context.clock.sleep(decision.delayMs);
        if (decision.input === "changed") {
          // The failed attempt's verification is new input for the next one: a new revision carries what failed.
          const failed = context.state().steps[index]!.attempts.at(-1)!;
          const evidence = retryEvidence(failed.verification?.evidence ?? [], {
            hiddenTests: (step.verification.hiddenTests ?? []).length > 0,
          });
          issuing = reviseHandoff(accepted!, { evidence });
        }
        break;
      }
      case "reroute": {
        // The budget is spent: the alternative agent takes the step over under the same contract, on budgets of
        // its own. What the failed verification showed goes with it; an attempt that taught nothing keeps the
        // evidence the step already had.
        const alternative = step.reroute!;
        await record({
          type: "retry_scheduled",
          stepId: step.id,
          attemptId: attempt.attemptId,
          failureClass: attempt.failureClass,
          change: "reroute",
          delayMs: 0,
        });
        const failed = context.state().steps[index]!.attempts.at(-1)!;
        const learned = retryEvidence(failed.verification?.evidence ?? [], { hiddenTests: (step.verification.hiddenTests ?? []).length > 0 });
        agent = alternative;
        issuing = reviseHandoff(accepted!, {
          evidence: learned.length > 0 ? learned : accepted!.evidence,
          to: { adapter: alternative.adapter, requestedModel: alternative.model ?? null },
        });
        break;
      }
    }
  }
}

/**
 * Records the issue of a handoff revision, has it validated as a recipient would receive it, and records the
 * decision. Returns the validated revision, or null after ending the step as `rejected`.
 */
async function issueHandoff(step: StepDefinition, handoff: HandoffRevision, context: StepContext): Promise<HandoffRevision | null> {
  const { record, location } = context;
  await record({ type: "handoff_issued", handoff });
  // Validate the document as a recipient would receive it, not the object the runtime built.
  const validation = await validateHandoffRevision(JSON.parse(JSON.stringify(handoff)), location.repo);
  if (!validation.accepted) {
    const { handoffId, revision } = handoff;
    await record({ type: "handoff_rejected", handoffId, revision, reasons: validation.reasons });
    await record({ type: "step_terminal", stepId: step.id, state: "failed", failureClass: "rejected" });
    return null;
  }
  await record({ type: "handoff_accepted", handoffId: handoff.handoffId, revision: handoff.revision });
  return validation.handoff;
}

interface AttemptResult {
  attemptId: string;
  /** Null when the attempt passed verification. */
  failureClass: FailureClass | null;
  /** How many times the attempt's verification ran; 0 when its agent did not end cleanly. */
  validatorRuns: number;
}

/**
 * One attempt: a fresh workspace from the base commit, one coding-agent process, a snapshot, and, if the agent
 * ended cleanly, verification. An attempt whose agent did not end cleanly (non-zero exit, a stop reason that
 * means it gave up, an error its adapter reported) is not verified: it has no finished result to check. A
 * verification that could not run is re-run once, as the failure policy says, before it counts as inconclusive.
 * The attempt's failure class, if any, is recorded before this returns.
 */
async function executeAttempt(
  step: StepDefinition,
  index: number,
  agent: AgentRef,
  handoff: HandoffRevision,
  base: string,
  context: StepContext,
): Promise<AttemptResult> {
  const { runId, worktreeRoot, location, record } = context;
  const adapter = adapterFor(step, agent, context);
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
    requestedModel: agent.model ?? null,
    workspace,
  });
  const attemptNumber = context.state().steps[index]!.attempts.length;
  await addWorktree(location.repo, workspace, base);

  await record({ type: "attempt_dispatching", attemptId });
  const started = await adapter.startAttempt({
    attemptId,
    attemptNumber,
    workspace,
    requestedModel: agent.model ?? null,
    handoff,
    options: agent.options,
  });
  await record({ type: "attempt_running", attemptId, pid: started.pid });
  const exit = await started.exited;
  const exitClass = classifyAttempt({ ...exit, verdict: null });
  await record({ type: "attempt_exited", attemptId, outcome: exitClass === null ? "ok" : "error", ...exit });

  const ref = snapshotRef(runId, attemptId);
  const snapshot = await snapshotWorktree(workspace, ref, `AHP snapshot of ${runId} step ${step.id} attempt ${attemptId}`);
  await record({ type: "workspace_snapshot_committed", attemptId, commit: snapshot, ref });

  let failureClass = exitClass;
  let validatorRuns = 0;
  if (exitClass === null) {
    const verifyInput = { step, base, snapshot, attemptId, reportedOutput: exit.reportedOutput };
    for (;;) {
      const verdict = await verifyAttempt(verifyInput, context);
      validatorRuns += 1;
      failureClass = classifyAttempt({ ...exit, verdict });
      if (failureClass !== "inconclusive") break;
      const next = decideAfterFailure({
        failureClass,
        policy: resolveRetryPolicy(step.retry),
        usage: context.state().steps[index]!.retryUsage,
        validatorRuns,
        reroute: false,
      });
      if (next.action !== "rerun_validator") break;
    }
  }
  if (failureClass !== null) await record({ type: "attempt_failed", attemptId, failureClass });
  return { attemptId, failureClass, validatorRuns };
}

interface VerifyInput {
  step: StepDefinition;
  /** The step's base commit: the diff scope is measured from it. */
  base: string;
  /** The attempt's snapshot commit: the verification worktree is built from it. */
  snapshot: string;
  attemptId: string;
  reportedOutput: Readonly<Record<string, unknown>>;
}

/** Runs one verification of an attempt's snapshot and records it and its verdict. */
async function verifyAttempt(input: VerifyInput, context: StepContext): Promise<Exclude<VerificationState, "pending">> {
  const { step, base, snapshot, attemptId, reportedOutput } = input;
  const { runId, worktreeRoot, location, record } = context;
  const verificationId = newId("ver");
  const evidence: EvidenceItem[] = [];
  // Whether the attempt stayed out of the protected paths is known before anything runs. A violation fails
  // verification whatever the command says, so the command, which would run the attempt's changes to the test
  // runner and scripts, is not run. If the check itself cannot be made, the command is not run either.
  const hiddenTests = step.verification.hiddenTests ?? [];
  const protectedPaths = [...new Set([...(step.verification.protectedPaths ?? []), ...hiddenTests.map((test) => test.path)])];
  let scopeClear = true;
  if (protectedPaths.length > 0) {
    try {
      const changed = await changedPaths(location.repo, base, snapshot);
      const check = checkProtectedPaths(changed, protectedPaths);
      evidence.push(diffScopeEvidence(changed), check);
      scopeClear = check.violations.length === 0;
    } catch (error) {
      evidence.push(validatorError("diff_scope", error));
      scopeClear = false;
    }
  }
  // A structural verification runs no command, so it needs no verification worktree.
  const command = step.verification.command;
  const commandRun =
    command === undefined || !scopeClear ? null : { command, worktree: worktreePath(worktreeRoot, runId, verificationId) };
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
  if (requiredFields.length > 0) evidence.push(checkRequiredOutputFields(requiredFields, reportedOutput));
  const verdict = verdictOf(evidence);
  await record({ type: "verification_verdict", verificationId, verdict, evidence });
  return verdict;
}
