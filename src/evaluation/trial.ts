// One trial: a condition's workflow run against a fresh repository made from a task's fixture, then scored by the
// validators. The trial's repository stays in the evaluation's directory (its run ledger and pinned snapshots are inside it),
// with what an auditor needs beside it: the configuration, what each agent was sent and printed, the diff of the result and
// the validators' evidence. Everything a trial keeps is named by path and SHA-256 in its `trial_ended` event.

import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { PROTOCOL_VERSION, type AttemptView, type RunView, type WorkflowDefinition } from "../protocol/index.ts";
import { discardWorktree, git, locateRepo, locateRun, messageOf, newId, prepareWorktreeRoot, transcriptPaths, type Clock, type PullRequestProvider } from "../runtime/index.ts";
import { readRunEvents, runWorkflow } from "../sdk/index.ts";
import { retryBudgetOf, workflowFor } from "./conditions.ts";
import type { EvaluationEventBody, ScheduledTrial, StoredFile, TrialArtifacts } from "./events.ts";
import { sha256Of } from "./freeze.ts";
import type { EvaluationSuite } from "./suite.ts";
import type { LoadedTask } from "./task.ts";
import { validateResult, type Validation } from "./validators.ts";
import { workOf } from "./work.ts";

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

/**
 * The workflow as a trial's configuration records it: the hidden tests by path and hash, not their text. The frozen task
 * holds them, and the configuration sits beside the trial's repository, which an agent has no business reading.
 */
const withoutHiddenTests = (workflow: WorkflowDefinition) => ({
  ...workflow,
  steps: workflow.steps.map((step) =>
    "verification" in step && step.verification.hiddenTests
      ? { ...step, verification: { ...step.verification, hiddenTests: step.verification.hiddenTests.map(({ path, content }) => ({ path, sha256: sha256Of(content) })) } }
      : step,
  ),
});

/** What a trial has to show for itself so far, kept as it goes so an error partway still says how far it got. */
interface Progress {
  base: string | null;
  runId: string | null;
  state: RunView | null;
}

/**
 * Runs one trial of `condition` on the task and records it: `trial_started` before anything is made, and `trial_ended` however
 * it ends: scored, a harness incident, unscored (with why) or cancelled. AHP throwing partway is a `harness_error` of that one
 * trial, not the end of the evaluation. The task is the one that was just checked against its freeze.
 */
export async function runTrial(ctx: TrialContext, loaded: LoadedTask, scheduled: ScheduledTrial): Promise<{ trialId: string; ended: TrialEndedBody }> {
  const { task } = loaded;
  const { condition, repeat, baseline } = scheduled;
  const trialId = newId("trial");
  const trialDir = join(ctx.dir, "trials", trialId);
  const repo = join(trialDir, "repo");
  const workflow = workflowFor(condition, task, ctx.suite, { condition, repeat, baselineIndex: baseline?.index ?? null });
  const retryBudget = retryBudgetOf(condition, ctx.suite);
  const config = await store(
    ctx.dir,
    join(trialDir, "config.json"),
    `${JSON.stringify({ trialId, condition, repeat, baseline, task: { id: task.id, dir: loaded.dir, hash: loaded.hash }, retryBudget, platform: process.platform, node: process.version, protocolVersion: PROTOCOL_VERSION, workflow: withoutHiddenTests(workflow) }, null, 2)}\n`,
  );
  await ctx.record({ type: "trial_started", trialId, taskId: task.id, condition, repeat, baseline, repo: relativeTo(ctx.dir, repo), config });

  const place: TrialPlace = { trialId, trialDir, repo, config };
  const progress: Progress = { base: null, runId: null, state: null };
  let ended: TrialEndedBody;
  try {
    ended = await execute(ctx, loaded, workflow, place, progress);
  } catch (error) {
    // What the trial had made when AHP threw is kept as far as it goes: a run, if there was one, and the configuration anyway.
    const artifacts = await keepArtifacts({ ctx, place, runId: progress.runId, attempts: attemptsOf(progress.state), base: progress.base, commit: null, validation: null });
    ended = endOf(trialId, progress, { outcome: "unscored", unscored: { reason: "harness_error", detail: messageOf(error).slice(0, MAX_DETAIL_CHARS) }, artifacts });
  }
  await removeWorkspaces(repo, progress.state);
  await ctx.record(ended);
  return { trialId, ended };
}

const attemptsOf = (state: RunView | null): AttemptView[] => state?.steps.flatMap((step) => step.attempts) ?? [];

/**
 * Removes the attempts' worktrees, which can hold whatever an agent installed (`node_modules`) and, over an evaluation's many
 * trials, a great deal of disk; the result is kept as the snapshot commit in the trial's repository, and the diff beside it.
 * An unknown attempt's is left: its agent may still be running, and its workspace is all that is known of what it did.
 * Best effort: a worktree that cannot be removed (a handle still open on Windows) is no reason to fail the trial.
 */
async function removeWorkspaces(repo: string, state: RunView | null): Promise<void> {
  for (const attempt of attemptsOf(state)) {
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
async function execute(ctx: TrialContext, loaded: LoadedTask, workflow: WorkflowDefinition, place: TrialPlace, progress: Progress): Promise<TrialEndedBody> {
  const { trialId, repo } = place;
  const base = await createFixtureRepo(repo, loaded);
  progress.base = base;
  const { runId, state } = await runWorkflow(workflow, {
    repo,
    signal: ctx.signal,
    clock: ctx.clock,
    pullRequests: noExternalActions,
    // As the run goes, so an error partway still leaves the run's id and how far it had got.
    onEvent: (_event, current) => {
      progress.runId = current.runId;
      progress.state = current;
    },
  });
  progress.runId = runId;
  progress.state = state;
  const attempts = attemptsOf(state);
  const kept = (candidate: { commit: string } | null, validation: Validation | null) =>
    keepArtifacts({ ctx, place, runId, attempts, base, commit: candidate?.commit ?? null, validation });

  // A cancel first: Ctrl+C can leave an attempt unknown (a kill that could not be confirmed), which is the cancel's doing.
  // While cancelling, the runtime waits for a person to decide such an attempt instead of applying the step's `abort`, so the
  // run is left in `needs_recovery`: `ahp recover <attempt> --policy abort --repo <the trial's repository>` ends it.
  if (state.state === "cancelled" || (ctx.signal?.aborted && state.state !== "succeeded" && state.state !== "failed")) {
    return endOf(trialId, progress, { outcome: "cancelled", artifacts: await kept(null, null) });
  }
  // An attempt whose outcome is unknown may have done anything and may still be running: nothing of the trial is scored.
  const unknown = attempts.find((attempt) => attempt.state === "unknown");
  if (unknown) {
    const recovery = unknown.recovery!;
    const artifacts = await kept(null, null);
    await ctx.record({ type: "harness_incident", trialId, attemptId: unknown.id, unknownReason: recovery.reason, detail: recovery.detail.slice(0, MAX_DETAIL_CHARS) });
    return endOf(trialId, progress, { outcome: "harness_incident", artifacts });
  }
  if (state.state !== "succeeded" && state.state !== "failed") {
    return endOf(trialId, progress, { outcome: "unscored", unscored: { reason: "harness_error", detail: `the run stopped in state ${state.state}, which an evaluation's run never does` }, artifacts: await kept(null, null) });
  }
  const failed = state.steps.find((step) => step.state === "failed");
  if (failed && (failed.failureClass === "config_auth" || failed.failureClass === "rejected")) {
    // Whichever step it was: a login or configuration problem means the condition did not run as configured.
    const said = failed.attempts.at(-1)?.error?.message;
    const detail = `step "${failed.id}" ended ${failed.failureClass}${said ? `: ${said}` : ""}: the condition could not run as configured`.slice(0, MAX_DETAIL_CHARS);
    return endOf(trialId, progress, { outcome: "unscored", unscored: { reason: "setup_failed", detail }, artifacts: await kept(null, null) });
  }

  const candidate = await resultOf(repo, runId, base);
  const validation = await validateResult({ repo, runId, worktreeRoot: await prepareWorktreeRoot(), task: loaded.task, base, commit: candidate.commit, signal: ctx.signal });
  const artifacts = await kept(candidate, validation);
  const result = { ...candidate, changed: validation.evidence.changed.length > 0 };
  // A measure beside the score: one that cannot be taken is left out, and never changes how the trial ended.
  const work = await workOf(repo, state, base, candidate.commit).catch(() => null);
  if (validation.state === "inconclusive") {
    // A validator cut short by the cancel says nothing about the trial, and the evaluation is stopping anyway.
    if (ctx.signal?.aborted) return endOf(trialId, progress, { outcome: "cancelled", result, work, artifacts });
    return endOf(trialId, progress, { outcome: "unscored", unscored: { reason: "validator_inconclusive", detail: validation.detail }, result, work, artifacts });
  }
  return endOf(trialId, progress, { outcome: "scored", score: validation.score, result, work, artifacts });
}

/** The commit to score: the last snapshot the run made, which is the work as it stands; the fixture if it made none. */
async function resultOf(repo: string, runId: string, base: string): Promise<{ commit: string; snapshot: boolean }> {
  const snapshots = (await readRunEvents({ repo, runId })).filter((event) => event.type === "workspace_snapshot_committed");
  const last = snapshots.at(-1);
  return last?.type === "workspace_snapshot_committed" ? { commit: last.commit, snapshot: true } : { commit: base, snapshot: false };
}

/** A `trial_ended` event from what the trial has shown so far and how it ended. */
function endOf(trialId: string, progress: Progress, how: Pick<TrialEndedBody, "outcome"> & Partial<Pick<TrialEndedBody, "unscored" | "score" | "result" | "work" | "artifacts">>): TrialEndedBody {
  const { state } = progress;
  const attempts = attemptsOf(state);
  const stepsAttempted = state?.steps.filter((step) => step.attempts.length > 0).length ?? 0;
  return {
    type: "trial_ended",
    trialId,
    runId: progress.runId,
    runState: state?.state ?? null,
    failureClass: state?.steps.find((step) => step.state === "failed")?.failureClass ?? null,
    mock: state?.mock ?? false,
    attempts: attempts.length,
    retries: attempts.length - stepsAttempted,
    wallTimeMs: state?.endedAt ? Date.parse(state.endedAt) - Date.parse(state.createdAt) : null,
    usage: attempts.map((attempt) => ({ attemptId: attempt.id, adapter: attempt.adapter, reportedModel: attempt.reportedModel, usage: attempt.usage })),
    work: how.work ?? null,
    unscored: how.unscored ?? null,
    result: how.result ?? null,
    score: how.score ?? null,
    artifacts: how.artifacts ?? null,
    outcome: how.outcome,
  };
}

interface KeepInput {
  ctx: TrialContext;
  place: TrialPlace;
  /** Null when no run was made, so there is nothing of one to keep. */
  runId: string | null;
  attempts: readonly AttemptView[];
  base: string | null;
  /** The commit scored, and the validators' evidence, when the trial was validated. */
  commit: string | null;
  validation: Validation | null;
}

/**
 * Copies what an auditor needs into the trial's directory, and names each file by path and hash: the configuration, what each
 * attempt's agent was sent and printed, the run's ledger, and, when the trial was validated, the result's diff and the
 * validators' evidence. Each is kept on its own: one that cannot be (a disk problem) is left out and named in `problem`, and
 * never changes how the trial is classified.
 */
async function keepArtifacts({ ctx, place, runId, attempts, base, commit, validation }: KeepInput): Promise<TrialArtifacts> {
  const { trialDir, repo, config } = place;
  const problems: string[] = [];
  const tried = async <T>(what: string, keeping: () => Promise<T>): Promise<T | null> => {
    try {
      return await keeping();
    } catch (error) {
      problems.push(`${what}: ${messageOf(error)}`);
      return null;
    }
  };
  const prompts: TrialArtifacts["prompts"] = [];
  const transcripts: TrialArtifacts["transcripts"] = [];
  let runLedger: StoredFile | null = null;
  let patch: StoredFile | null = null;
  let validationFile: StoredFile | null = null;
  if (runId !== null) {
    const location = await tried("locating the run", () => locateRepo(repo));
    for (const attempt of location ? attempts : []) {
      const files = transcriptPaths(location!, runId, attempt.id);
      const prompt = await tried(`prompts/${attempt.id}.txt`, () => keep(ctx.dir, files.input, join(trialDir, "prompts", `${attempt.id}.txt`)));
      const transcript = await tried(`transcripts/${attempt.id}.txt`, () => keep(ctx.dir, files.output, join(trialDir, "transcripts", `${attempt.id}.txt`)));
      if (prompt) prompts.push({ attemptId: attempt.id, file: prompt });
      if (transcript) transcripts.push({ attemptId: attempt.id, file: transcript });
    }
    runLedger = await tried("run-ledger.jsonl", async () => keep(ctx.dir, (await locateRun(repo, runId)).path, join(trialDir, "run-ledger.jsonl")));
    if (commit !== null && validation !== null && base !== null) {
      patch = await tried("result.patch", async () => {
        const diff = commit === base ? "" : `${await git(repo, ["diff", "--binary", "--no-renames", base, commit])}\n`;
        return store(ctx.dir, join(trialDir, "result.patch"), diff);
      });
      validationFile = await tried("validation.json", () => store(ctx.dir, join(trialDir, "validation.json"), `${JSON.stringify(validation.evidence, null, 2)}\n`));
    }
  }
  return { config, prompts, transcripts, problem: problems.length > 0 ? problems.join("; ").slice(0, MAX_DETAIL_CHARS) : null, runLedger, patch, validation: validationFile };
}
