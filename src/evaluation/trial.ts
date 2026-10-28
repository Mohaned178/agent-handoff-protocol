// One trial: a condition's workflow run against a fresh repository made from a task's fixture, then scored by the
// validators. The trial's repository stays in the evaluation's directory (its run ledger and pinned snapshots are inside it),
// with what an auditor needs beside it: the configuration, what each agent was sent and printed, the diff of the result and
// the validators' evidence. Everything a trial keeps is named by path and SHA-256 in its `trial_ended` event.

import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { PROTOCOL_VERSION, type AttemptView, type RunView } from "../protocol/index.ts";
import { discardWorktree, git, locateRepo, locateRun, messageOf, prepareWorktreeRoot, transcriptPaths, type Clock, type PullRequestProvider } from "../runtime/index.ts";
import { readRunEvents, runWorkflow } from "../sdk/index.ts";
import { workflowFor } from "./conditions.ts";
import type { ConditionId, EvaluationEventBody, StoredFile, TrialArtifacts } from "./events.ts";
import { sha256Of } from "./freeze.ts";
import type { EvaluationSuite } from "./suite.ts";
import type { LoadedTask } from "./task.ts";
import { validateResult, type Validation } from "./validators.ts";

export type TrialEndedBody = Extract<EvaluationEventBody, { type: "trial_ended" }>;

/** What a trial needs of the evaluation it belongs to. */
export interface TrialContext {
  suite: EvaluationSuite;
  /** The evaluation's directory. */
  dir: string;
  record: (body: EvaluationEventBody) => Promise<unknown>;
  signal?: AbortSignal;
  clock?: Clock;
}

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

/** A path relative to the evaluation's directory, with `/` separators, as the ledger names files. */
const relativeTo = (dir: string, path: string) => relative(dir, path).split("\\").join("/");

const MAX_DETAIL_CHARS = 2000;

/** Writes `content` to `path`, making its directory, and names it by place and hash. */
async function store(dir: string, path: string, content: string | Buffer): Promise<StoredFile> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return { path: relativeTo(dir, path), sha256: sha256Of(bytes), bytes: bytes.length };
}

/** Copies an existing file into the trial's directory and names the copy; null when there is nothing to copy. */
async function keep(dir: string, from: string, to: string): Promise<StoredFile | null> {
  if (!(await stat(from).catch(() => null))?.isFile()) return null;
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  const bytes = await readFile(to);
  return { path: relativeTo(dir, to), sha256: sha256Of(bytes), bytes: bytes.length };
}

/** A repository whose one commit is the task's fixture, byte for byte; returns the commit. */
async function createFixtureRepo(repo: string, loaded: LoadedTask): Promise<string> {
  await mkdir(repo, { recursive: true });
  for (const [path, bytes] of loaded.task.fixture) {
    const target = join(repo, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  // No template (a user's would bring hooks), and no line-ending conversion: the fixture is committed as it was hashed.
  await git(repo, ["init", "--quiet", "--initial-branch=main", "--template="]);
  for (const [key, value] of [["user.name", "AHP evaluation"], ["user.email", "ahp-evaluation@localhost"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) {
    await git(repo, ["config", key, value]);
  }
  await git(repo, ["add", "--all"]);
  await git(repo, ["commit", "--quiet", "--message", `fixture of task ${loaded.task.id}`]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** A pull-request provider that refuses everything: an evaluation performs no external action, so none may be reached. */
const noExternalActions: PullRequestProvider = {
  find: () => Promise.reject(new Error("an evaluation performs no external action")),
  open: () => Promise.reject(new Error("an evaluation performs no external action")),
  merge: () => Promise.reject(new Error("an evaluation performs no external action")),
};

/** What a trial has to show for itself so far, kept as it goes so an error partway still says how far it got. */
interface Progress {
  runId: string | null;
  state: RunView | null;
}

/**
 * Runs one trial of `condition` on the task and records it: `trial_started` before anything is made, and `trial_ended` however
 * it ends: scored, a harness incident, unscored (with why) or cancelled. AHP throwing partway is a `harness_error` of that one
 * trial, not the end of the evaluation. The task is the one that was just checked against its freeze.
 */
export async function runTrial(ctx: TrialContext, loaded: LoadedTask, condition: ConditionId): Promise<TrialEndedBody> {
  const { task } = loaded;
  const trialId = newId("trial");
  const trialDir = join(ctx.dir, "trials", trialId);
  const repo = join(trialDir, "repo");
  const workflow = workflowFor(condition, task, ctx.suite);
  const config = await store(
    ctx.dir,
    join(trialDir, "config.json"),
    `${JSON.stringify({ trialId, condition, task: { id: task.id, dir: loaded.dir, hash: loaded.hash }, retryBudget: ctx.suite.retryBudget ?? null, platform: process.platform, node: process.version, protocolVersion: PROTOCOL_VERSION, workflow }, null, 2)}\n`,
  );
  await ctx.record({ type: "trial_started", trialId, taskId: task.id, condition, repo: relativeTo(ctx.dir, repo), config });

  const progress: Progress = { runId: null, state: null };
  let ended: TrialEndedBody;
  try {
    ended = await execute(ctx, loaded, workflow, { trialId, trialDir, repo, config }, progress);
  } catch (error) {
    ended = endOf(trialId, progress, { outcome: "unscored", unscored: { reason: "harness_error", detail: messageOf(error).slice(0, MAX_DETAIL_CHARS) } });
  }
  await removeWorkspaces(repo, progress.state);
  await ctx.record(ended);
  return ended;
}

/**
 * Removes the attempts' worktrees, which can hold whatever an agent installed (`node_modules`) and, over an evaluation's many
 * trials, a great deal of disk; the result is kept as the snapshot commit in the trial's repository, and the diff beside it.
 * An unknown attempt's is left: its agent may still be running, and its workspace is all that is known of what it did.
 * Best effort: a worktree that cannot be removed (a handle still open on Windows) is no reason to fail the trial.
 */
async function removeWorkspaces(repo: string, state: RunView | null): Promise<void> {
  for (const attempt of state?.steps.flatMap((step) => step.attempts) ?? []) {
    if (attempt.state !== "unknown") await discardWorktree(repo, attempt.workspace).catch(() => undefined);
  }
}

interface TrialPlace {
  trialId: string;
  trialDir: string;
  repo: string;
  config: StoredFile;
}

/** Makes the trial's repository, runs the workflow in it, and works out how the trial ended. */
async function execute(ctx: TrialContext, loaded: LoadedTask, workflow: Parameters<typeof runWorkflow>[0], place: TrialPlace, progress: Progress): Promise<TrialEndedBody> {
  const { trialId, repo } = place;
  const base = await createFixtureRepo(repo, loaded);
  const { runId, state } = await runWorkflow(workflow, { repo, signal: ctx.signal, clock: ctx.clock, pullRequests: noExternalActions });
  progress.runId = runId;
  progress.state = state;
  const attempts = state.steps.flatMap((step) => step.attempts);
  const kept = (candidate: { commit: string } | null, validation: Validation | null) => keepArtifacts(ctx, place, runId, attempts, base, candidate?.commit ?? null, validation);

  // A cancel first: Ctrl+C can leave an attempt unknown (a kill that could not be confirmed), which is the cancel's doing.
  if (state.state === "cancelled" || (ctx.signal?.aborted && state.state !== "succeeded" && state.state !== "failed")) {
    return endOf(trialId, progress, { outcome: "cancelled", artifacts: await kept(null, null) });
  }
  // An attempt whose outcome is unknown may have done anything and may still be running: nothing of the trial is scored.
  const unknown = attempts.find((attempt) => attempt.state === "unknown");
  if (unknown) {
    const recovery = unknown.recovery!;
    await ctx.record({ type: "harness_incident", trialId, attemptId: unknown.id, unknownReason: recovery.reason, detail: recovery.detail.slice(0, MAX_DETAIL_CHARS) });
    return endOf(trialId, progress, { outcome: "harness_incident", artifacts: await kept(null, null) });
  }
  if (state.state !== "succeeded" && state.state !== "failed") {
    return endOf(trialId, progress, { outcome: "unscored", unscored: { reason: "harness_error", detail: `the run stopped in state ${state.state}, which an evaluation's run never does` }, artifacts: await kept(null, null) });
  }
  const failed = state.steps.find((step) => step.state === "failed");
  if (failed && (failed.failureClass === "config_auth" || failed.failureClass === "rejected")) {
    const said = (failed.attempts.at(-1) as AttemptView | undefined)?.error?.message;
    const detail = `step "${failed.id}" ended ${failed.failureClass}${said ? `: ${said}` : ""}: no coding agent did the work`.slice(0, MAX_DETAIL_CHARS);
    return endOf(trialId, progress, { outcome: "unscored", unscored: { reason: "setup_failed", detail }, artifacts: await kept(null, null) });
  }

  const candidate = await resultOf(repo, runId, base);
  const validation = await validateResult({ repo, runId, worktreeRoot: await prepareWorktreeRoot(), task: loaded.task, base, commit: candidate.commit, signal: ctx.signal });
  const artifacts = await kept(candidate, validation);
  if (validation.state === "inconclusive") {
    // A validator cut short by the cancel says nothing about the trial, and the evaluation is stopping anyway.
    if (ctx.signal?.aborted) return endOf(trialId, progress, { outcome: "cancelled", result: candidate, artifacts });
    return endOf(trialId, progress, { outcome: "unscored", unscored: { reason: "validator_inconclusive", detail: validation.detail }, result: candidate, artifacts });
  }
  return endOf(trialId, progress, { outcome: "scored", score: validation.score, result: candidate, artifacts });
}

/** The commit to score: the last snapshot the run made, which is the work as it stands; the fixture if it made none. */
async function resultOf(repo: string, runId: string, base: string): Promise<{ commit: string; snapshot: boolean }> {
  const snapshots = (await readRunEvents({ repo, runId })).filter((event) => event.type === "workspace_snapshot_committed");
  const last = snapshots.at(-1);
  return last?.type === "workspace_snapshot_committed" ? { commit: last.commit, snapshot: true } : { commit: base, snapshot: false };
}

/** A `trial_ended` event from what the trial has shown so far and how it ended. */
function endOf(trialId: string, progress: Progress, how: Pick<TrialEndedBody, "outcome"> & Partial<Pick<TrialEndedBody, "unscored" | "score" | "result" | "artifacts">>): TrialEndedBody {
  const { state } = progress;
  return {
    type: "trial_ended",
    trialId,
    runId: progress.runId,
    runState: state?.state ?? null,
    failureClass: state?.steps.find((step) => step.state === "failed")?.failureClass ?? null,
    mock: state?.mock ?? false,
    attempts: state?.steps.reduce((count, step) => count + step.attempts.length, 0) ?? 0,
    unscored: how.unscored ?? null,
    result: how.result ?? null,
    score: how.score ?? null,
    artifacts: how.artifacts ?? null,
    outcome: how.outcome,
  };
}

/**
 * Copies what an auditor needs into the trial's directory, and names each file by path and hash: the configuration, what each
 * attempt's agent was sent and printed, the run's ledger, and, when the trial was validated, the result's diff and the
 * validators' evidence.
 */
async function keepArtifacts(
  ctx: TrialContext,
  place: TrialPlace,
  runId: string,
  attempts: readonly AttemptView[],
  base: string,
  commit: string | null,
  validation: Validation | null,
): Promise<TrialArtifacts> {
  const { trialDir, repo, config } = place;
  const location = await locateRepo(repo);
  const prompts: TrialArtifacts["prompts"] = [];
  const transcripts: TrialArtifacts["transcripts"] = [];
  for (const attempt of attempts) {
    const files = transcriptPaths(location, runId, attempt.id);
    const prompt = await keep(ctx.dir, files.input, join(trialDir, "prompts", `${attempt.id}.txt`));
    const transcript = await keep(ctx.dir, files.output, join(trialDir, "transcripts", `${attempt.id}.txt`));
    if (prompt) prompts.push({ attemptId: attempt.id, file: prompt });
    if (transcript) transcripts.push({ attemptId: attempt.id, file: transcript });
  }
  const runLedger = await keep(ctx.dir, (await locateRun(repo, runId)).path, join(trialDir, "run-ledger.jsonl"));
  let patch: StoredFile | null = null;
  let validationFile: StoredFile | null = null;
  if (commit !== null && validation !== null) {
    const diff = commit === base ? "" : `${await git(repo, ["diff", "--binary", "--no-renames", base, commit])}\n`;
    patch = await store(ctx.dir, join(trialDir, "result.patch"), diff);
    validationFile = await store(ctx.dir, join(trialDir, "validation.json"), `${JSON.stringify(validation.evidence, null, 2)}\n`);
  }
  return { config, prompts, transcripts, runLedger, patch, validation: validationFile };
}
