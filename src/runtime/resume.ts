import { access, readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import type { Adapter } from "../adapters/index.ts";
import { clearStaleLock, findAttempt, LedgerWriter, lockPathOf, readCheckedLedger, replay } from "../ledger/index.ts";
import { RECOVERY_ACTIONS, type LedgerEvent, type LockOwner, type RecoveryAction, type RunView } from "../protocol/index.ts";
import { systemClock, type Clock } from "./clock.ts";
import { isAttemptId, isRunId, ledgerPath, locateRepo, prepareWorktreeRoot, runsDir, type RepoLocation } from "./paths.ts";
import { drive, runContext, type RunContext, type RunResult } from "./run.ts";

export interface ContinueRunOptions {
  /** Any directory inside the git repository the run works on. */
  repo: string;
  adapters: ReadonlyMap<string, Adapter>;
  /** Called after each event this process records, with the state derived so far. */
  onEvent?: (event: LedgerEvent, state: Readonly<RunView>) => void;
  clock?: Clock;
}

export interface RecoverAttemptOptions extends ContinueRunOptions {
  attemptId: string;
  policy: RecoveryAction;
}

/** `ahp recover` was asked for something that would not be a recovery: nothing was written. */
export class RecoveryRefusedError extends Error {
  override name = "RecoveryRefusedError";
}

export interface ResumeRunOptions extends ContinueRunOptions {
  runId: string;
}

export interface ResumeResult extends RunResult {
  /** False when the run had nothing to continue: it had ended, or it waits for a person's decision. */
  resumed: boolean;
  /** The process whose stale lock was removed, if one was. */
  takenOverFrom: LockOwner | null;
}

/**
 * Continues a run whose process stopped before the run ended, from wherever its ledger says it got to, taking over
 * the stale lock that process left. An attempt that was dispatched and has no record of how it ended is never
 * dispatched again: it is `unknown`, and its step's recovery policy, or a person, decides what becomes of it. A run
 * that has ended, or that waits for a decision, is left as it is (a stale lock its process left is removed).
 */
export async function resumeRun(options: ResumeRunOptions): Promise<ResumeResult> {
  const { runId } = options;
  if (!isRunId(runId)) throw new Error(`not a run ID: ${runId}`);
  const location = await locateRepo(options.repo);
  const path = ledgerPath(location, runId);
  if (!(await exists(path))) throw new Error(`no run ${runId} in ${location.repo}`);
  const state = replay((await readCheckedLedger(path)).events);
  if (!continuable(state)) return { runId, state, resumed: false, takenOverFrom: await clearStaleLock(lockPathOf(path)) };

  const { run, writer, takenOverFrom } = await openRun(location, runId, options);
  try {
    // Again under the lock: the run may have moved on in between.
    if (!continuable(run.state())) return { runId, state: run.state(), resumed: false, takenOverFrom };
    await run.record({ type: "run_resumed", takenOverFrom });
    await drive(run);
    return { runId, state: run.state(), resumed: true, takenOverFrom };
  } finally {
    await writer.close();
  }
}

/** A run is continued only while a process was taking it forward; any other state is one a person or nobody moves on. */
const continuable = (state: Readonly<RunView>) => state.state === "pending" || state.state === "running";

/**
 * Applies a person's decision to an attempt that awaits recovery, then resumes its run: `adopt` verifies the
 * attempt's workspace as its result, `abort` ends its step. Refuses, writing nothing, unless the attempt is one
 * its run stopped for and nobody has decided yet.
 */
export async function recoverAttempt(options: RecoverAttemptOptions): Promise<RunResult> {
  const { attemptId, policy } = options;
  if (!isAttemptId(attemptId)) throw new RecoveryRefusedError(`not an attempt ID: ${attemptId}`);
  if (!RECOVERY_ACTIONS.includes(policy)) throw new RecoveryRefusedError(`not a recovery decision: ${policy} (adopt or abort)`);
  const location = await locateRepo(options.repo);
  const runId = await runOfAttempt(location, attemptId);
  // Looked at before taking the lock, so a refusal leaves the run, and whoever holds its lock, alone.
  await refuseUnlessAwaiting(replay((await readCheckedLedger(ledgerPath(location, runId))).events), attemptId, policy);
  const { run, writer, takenOverFrom } = await openRun(location, runId, options);
  try {
    // Again under the lock: another process may have decided in between.
    await refuseUnlessAwaiting(run.state(), attemptId, policy);
    await run.record({ type: "run_resumed", takenOverFrom });
    await run.record({ type: "recovery_decided", attemptId, policy, decidedBy: "human", user: currentUser() });
    await drive(run);
    return { runId, state: run.state() };
  } finally {
    await writer.close();
  }
}

/**
 * Opens an existing run to continue it, taking over a stale lock: whoever calls this was asked by a person to
 * continue the run, and records that it did (`run_resumed`, naming the stale lock's process) before anything else.
 */
async function openRun(location: RepoLocation, runId: string, options: ContinueRunOptions) {
  const clock = options.clock ?? systemClock;
  const worktreeRoot = await prepareWorktreeRoot();
  const { writer, events, takenOverFrom } = await LedgerWriter.open(ledgerPath(location, runId), () => clock.now(), {
    takeOverStale: true,
  });
  const created = events[0]!;
  if (created.type !== "run_created") {
    await writer.close();
    throw new Error(`run ${runId}: the first event is ${created.type}, not run_created`);
  }
  const fields = { runId, location, worktreeRoot, adapters: options.adapters, workflow: created.workflow, clock };
  const run: RunContext = runContext(writer, events, fields, options.onEvent);
  return { run, writer, takenOverFrom };
}

/** The run whose ledger records the attempt. */
async function runOfAttempt(location: RepoLocation, attemptId: string): Promise<string> {
  let runIds: string[] = [];
  try {
    runIds = (await readdir(runsDir(location))).filter(isRunId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // As the ledger writes it: every event about an attempt names it so.
  const mention = `"attemptId":"${attemptId}"`;
  for (const runId of runIds.sort()) {
    const text = await readFile(ledgerPath(location, runId), "utf8").catch(() => "");
    if (text.includes(mention)) return runId;
  }
  throw new RecoveryRefusedError(`no attempt ${attemptId} in ${location.repo}`);
}

/** Throws `RecoveryRefusedError` unless the attempt awaits a person's decision and `policy` can be applied to it. */
async function refuseUnlessAwaiting(state: Readonly<RunView>, attemptId: string, policy: RecoveryAction): Promise<void> {
  const found = findAttempt(state, attemptId);
  if (!found) throw new RecoveryRefusedError(`no attempt ${attemptId} in run ${state.runId}`);
  const { attempt } = found;
  const recovery = attempt.recovery;
  const notAwaiting = (why: string) => new RecoveryRefusedError(`attempt ${attemptId} is not awaiting recovery: ${why}`);
  if (recovery?.decision) {
    const { policy: decided, decidedBy, user, time } = recovery.decision;
    throw notAwaiting(`its recovery was already decided (${decided}, by ${decidedBy === "human" ? user : "the step's recovery policy"} at ${time})`);
  }
  if (!recovery?.awaited) {
    if (attempt.state === "exited") throw notAwaiting(`it exited (${attempt.outcome})`);
    if (attempt.state === "created") throw notAwaiting("it was never dispatched");
    throw notAwaiting(
      `it is ${attempt.state} and run ${state.runId} has not stopped for a decision; if the process running it has stopped, \`ahp recover ${state.runId}\` examines the run and resumes it`,
    );
  }
  if (policy === "adopt" && !(await exists(attempt.workspace))) {
    throw new RecoveryRefusedError(
      `attempt ${attemptId} cannot be adopted: its workspace ${attempt.workspace} is gone, so there is no result to adopt; \`--policy abort\` ends the step`,
    );
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Who is deciding, as the operating system names the user running this process. */
function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? "unknown";
  }
}
