// The independent validators: they score a trial from what it left, after its run has ended, in a verification worktree of
// their own built from the final snapshot commit. They share the runtime's low-level helpers (a worktree, hidden tests put
// in place, a command run through the shell) and none of its verdicts: the in-run verification of a step, which C0 does
// not even have, never decides a trial's score, and an agent's own report is not looked at.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_GRACE_MS } from "../process/index.ts";
import type { ChangedPath } from "../protocol/index.ts";
import {
  addWorktree,
  changedPaths,
  checkProtectedPaths,
  discardWorktree,
  evidenceVerdict,
  installDependencies,
  introduceHiddenTests,
  messageOf,
  runVerificationCommand,
  systemClock,
  worktreePath,
  type CommandCancel,
} from "../runtime/index.ts";
import { forbiddenPatternViolations } from "./checks.ts";
import type { ConstraintOutcome, TrialScore } from "./events.ts";
import type { EvaluationTask } from "./task.ts";

export interface ValidationInput {
  /** The trial's repository. */
  repo: string;
  /** The run's id, which names the validators' worktrees under AHP's worktree root. */
  runId: string;
  worktreeRoot: string;
  task: EvaluationTask;
  /** The fixture commit: what a trial started from. */
  base: string;
  /** The commit to score: the last snapshot the run made, or `base` if it made none. */
  commit: string;
  /** Cancels a validator command that is still running. */
  signal?: AbortSignal;
}

/** What one constraint's check found. */
export interface ConstraintFinding {
  id: string;
  kind: "forbidden_pattern" | "required_invariant";
  outcome: ConstraintOutcome;
  /** The files that matched a forbidden pattern, or the invariant command's exit code and the end of its output. */
  detail: string;
}

/** Everything the validators saw, kept with the trial. */
export interface ValidationEvidence {
  commit: string;
  base: string;
  /** What the result changed against the fixture. */
  changed: ChangedPath[];
  protected: string[];
  /** The hidden tests' command and its output; null when it was not run because a protected path was changed. */
  tests: { command: string; exitCode: number | null; signal: string | null; output: string; truncated: boolean } | null;
  constraints: ConstraintFinding[];
  /** 1, or 2 when the first run was inconclusive and the validators ran once more. */
  validatorRuns: number;
}

export type Validation =
  /** The validators ran to a result. */
  | { state: "scored"; score: TrialScore; evidence: ValidationEvidence }
  /** A validator could not run to a result, in two runs: it says nothing about the trial. */
  | { state: "inconclusive"; detail: string; evidence: ValidationEvidence };

const MAX_FINDING_CHARS = 1500;

/**
 * Scores the result commit: a pass is the hidden tests passing with no protected path changed; each planted constraint is
 * checked apart and does not decide it. A validator that cannot run to a result (an install that fails, a command that is
 * not there) is re-run once, as the runtime re-runs an inconclusive verification, and then reported as inconclusive.
 */
export async function validateResult(input: ValidationInput): Promise<Validation> {
  const first = await validateOnce(input, 1);
  if (first.state !== "inconclusive" || input.signal?.aborted) return first;
  return validateOnce(input, 2);
}

async function validateOnce(input: ValidationInput, validatorRun: number): Promise<Validation> {
  const { repo, task } = input;
  const evidence: ValidationEvidence = { commit: input.commit, base: input.base, changed: [], protected: [], tests: null, constraints: [], validatorRuns: validatorRun };
  const inconclusive = (stage: string, error: unknown): Validation => ({ state: "inconclusive", detail: `${stage}: ${messageOf(error)}`.slice(0, MAX_FINDING_CHARS), evidence });

  evidence.protected = [...new Set([...task.verification.protectedPaths, ...task.hiddenTests.map((test) => test.path)])];
  let violations: string[];
  try {
    evidence.changed = await changedPaths(repo, input.base, input.commit);
    violations = checkProtectedPaths(evidence.changed, evidence.protected).violations.map((change) => change.path);
  } catch (error) {
    return inconclusive("diff scope", error);
  }

  const cancel: CommandCancel = { signal: input.signal, graceMs: DEFAULT_GRACE_MS, clock: systemClock, beforeStop: async () => undefined };
  const worktree = worktreePath(input.worktreeRoot, input.runId, `validation-${validatorRun}`);
  let created = false;
  let stage = "verification worktree";
  try {
    await addWorktree(repo, worktree, input.commit);
    created = true;

    // Patterns first, over the result as the snapshot holds it: before anything is installed, and before the hidden tests
    // (which may name the very words a constraint forbids) are written.
    stage = "forbidden patterns";
    const files = await filesOf(worktree);
    for (const constraint of task.constraints) {
      if (constraint.check.kind !== "forbidden_pattern") continue;
      const matched = forbiddenPatternViolations(constraint.check, files);
      evidence.constraints.push({ id: constraint.id, kind: "forbidden_pattern", outcome: matched.length > 0 ? "violated" : "held", detail: matched.length > 0 ? matched.join(", ") : "no match" });
    }

    if (task.verification.install !== undefined) {
      stage = "install";
      await installDependencies(task.verification.install, worktree, cancel);
    }
    stage = "hidden tests";
    await introduceHiddenTests(worktree, task.hiddenTests);

    // A changed protected path fails the trial whatever the tests say, as it fails a step's verification: they are not run.
    let testsPass = false;
    if (violations.length === 0) {
      stage = "tests";
      const output = await runVerificationCommand(task.verification.command, worktree, cancel);
      evidence.tests = { command: output.command, exitCode: output.exitCode, signal: output.signal, output: output.output, truncated: output.truncated };
      const verdict = evidenceVerdict(output);
      if (verdict === "inconclusive") throw new Error(`the command ended ${output.exitCode === null ? `on signal ${output.signal ?? "unknown"}` : `with exit code ${output.exitCode}`}, which says the command could not be run`);
      testsPass = verdict === "pass";
    }

    stage = "required invariants";
    for (const constraint of task.constraints) {
      if (constraint.check.kind !== "required_invariant") continue;
      const output = await runVerificationCommand(constraint.check.command, worktree, cancel);
      const verdict = evidenceVerdict(output);
      const ended = output.exitCode === null ? `ended on signal ${output.signal ?? "unknown"}` : `exited ${output.exitCode}`;
      evidence.constraints.push({
        id: constraint.id,
        kind: "required_invariant",
        outcome: verdict === "pass" ? "held" : verdict === "fail" ? "violated" : "inconclusive",
        detail: `${ended}: ${output.output.slice(-MAX_FINDING_CHARS)}`,
      });
    }
    const unclear = evidence.constraints.find((finding) => finding.outcome === "inconclusive");
    if (unclear) throw new Error(`the check of constraint "${unclear.id}" could not run: ${unclear.detail}`);

    const score: TrialScore = {
      verdict: violations.length === 0 && testsPass ? "pass" : "fail",
      tests: { command: task.verification.command, exitCode: evidence.tests?.exitCode ?? null, ran: evidence.tests !== null },
      protectedPathViolations: violations,
      constraints: task.constraints.map((constraint) => ({ id: constraint.id, outcome: evidence.constraints.find((finding) => finding.id === constraint.id)!.outcome as "held" | "violated" })),
    };
    return { state: "scored", score, evidence };
  } catch (error) {
    return inconclusive(stage, error);
  } finally {
    if (created) await discardWorktree(repo, worktree).catch(() => undefined);
  }
}

/** Every file of `directory`, by path relative to it with `/` separators, leaving out git's own. */
async function filesOf(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(absolute: string, relative: string): Promise<void> {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(absolute, entry.name), path);
      else if (entry.isFile()) files.set(path, await readFile(join(absolute, entry.name)));
    }
  }
  await walk(directory, "");
  return files;
}
