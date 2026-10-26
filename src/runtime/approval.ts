import { readCheckedLedger, replay } from "../ledger/index.ts";
import type { ApprovalDecisionKind, ApprovalView, RunView, StepView } from "../protocol/index.ts";
import { isPresentOutputField } from "../protocol/index.ts";
import { git } from "./git.ts";
import { locateRun } from "./paths.ts";
import { currentUser, openRun, type ContinueRunOptions } from "./resume.ts";
import { drive, type RunResult } from "./run.ts";

/** `ahp approve` or `ahp reject` was asked for something that is not a decision on a waiting gate: nothing was written. */
export class ApprovalRefusedError extends Error {
  override name = "ApprovalRefusedError";
}

export interface DecideApprovalOptions extends ContinueRunOptions {
  runId: string;
  /** The approval gate to decide. */
  stepId: string;
  decision: ApprovalDecisionKind;
  /** Why the work is rejected: required for a rejection, and reaches the coding agent. An approval gives none. */
  reason?: string;
}

/**
 * Records a person's decision at an approval gate the run is waiting at, then resumes the run: an approval lets it go
 * on, a rejection sends the step before the gate back (or fails the run when that step has no retry budget left).
 * Takes the run's ledger lock, so it refuses while a process is writing the run. Refuses, writing nothing, unless the
 * step is a gate with an open request.
 */
export async function decideApproval(options: DecideApprovalOptions): Promise<RunResult> {
  const { runId, stepId, decision } = options;
  const reason = decision === "rejected" ? (options.reason ?? "").trim() : null;
  if (decision === "rejected" && !isPresentOutputField(reason)) {
    throw new ApprovalRefusedError("a rejection needs a reason, which is sent back with the work");
  }
  if (decision === "approved" && options.reason !== undefined) throw new ApprovalRefusedError("an approval carries no reason");
  const { location, path } = await locateRun(options.repo, runId);
  // Looked at before taking the lock, so a refusal leaves the run, and whoever holds its lock, alone.
  refuseUnlessWaiting(replay((await readCheckedLedger(path)).events), stepId);
  const { run, writer, takenOverFrom } = await openRun(location, runId, options);
  try {
    // Again under the lock: another process may have decided in between.
    refuseUnlessWaiting(run.state(), stepId);
    await run.record({ type: "run_resumed", takenOverFrom });
    await run.record({ type: "approval_decided", stepId, decision, reason, user: currentUser() });
    await drive(run);
    return { runId, state: run.state() };
  } finally {
    await writer.close();
  }
}

/** The gate's request that nobody has decided, if the run is stopped at it. */
export function openApproval(state: Readonly<RunView>, gate: StepView): ApprovalView | undefined {
  const open = gate.approvals.at(-1);
  return state.state === "waiting_approval" && gate.state === "waiting_approval" && open && !open.decision ? open : undefined;
}

/** Throws `ApprovalRefusedError` unless the step is an approval gate that the run is waiting at. */
function refuseUnlessWaiting(state: Readonly<RunView>, stepId: string): void {
  const gate = state.steps.find((step) => step.id === stepId);
  if (!gate) throw new ApprovalRefusedError(`no step ${stepId} in run ${state.runId} (its steps: ${state.steps.map((s) => s.id).join(", ")})`);
  const notWaiting = (why: string) => new ApprovalRefusedError(`step ${stepId} is not waiting for approval: ${why}`);
  if (gate.kind !== "approval_gate") throw notWaiting("it is not an approval gate");
  if (openApproval(state, gate)) return;
  const decided = gate.approvals.at(-1)?.decision;
  if (decided && gate.state === "waiting_approval") {
    const resume = state.endedAt === null ? `; \`ahp recover ${state.runId}\` continues the run` : "";
    throw notWaiting(`it was already ${decided.decision} by ${decided.user} at ${decided.time}${resume}`);
  }
  if (state.endedAt !== null) throw notWaiting(`run ${state.runId} already ended (${state.state})`);
  throw notWaiting(`the step is ${gate.state} and the run is ${state.state}`);
}

/** How much of a diff `ahp inspect` shows; the rest is left to git. */
const MAX_DIFF_CHARS = 64 * 1024;

/** What a person approving is shown beyond what the ledger holds: the diff itself, read from the pinned snapshot commit. */
export interface PendingApproval {
  stepId: string;
  /** The unified diff from the run's base commit to the verified snapshot; null when git could not produce it. */
  diff: string | null;
  /** True when `diff` is only the start of a longer one. */
  diffTruncated: boolean;
  /** Why the diff could not be read, if it could not. */
  diffError: string | null;
}

/** The diff of the gate the run is waiting at, or null when it is waiting at none. Read-only: it takes no lock. */
export async function pendingApprovalOf(state: Readonly<RunView>): Promise<PendingApproval | null> {
  for (const gate of state.steps) {
    const open = openApproval(state, gate);
    if (!open) continue;
    try {
      // The snapshot commit, never a worktree. No external diff program or text conversion from the repository's config runs.
      const args = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", open.base, open.commit];
      const diff = await git(state.repo, args);
      return { stepId: gate.id, diff: diff.slice(0, MAX_DIFF_CHARS), diffTruncated: diff.length > MAX_DIFF_CHARS, diffError: null };
    } catch (error) {
      return { stepId: gate.id, diff: null, diffTruncated: false, diffError: (error as Error).message };
    }
  }
  return null;
}
