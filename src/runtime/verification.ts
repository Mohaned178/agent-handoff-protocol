import { spawn } from "node:child_process";
import { OWN_PROCESS_GROUP, terminateTree } from "../process/index.ts";
import {
  isPresentOutputField,
  type EvidenceItem,
  type RequiredOutputFieldsEvidence,
  type TestOutputEvidence,
  type ValidatorErrorEvidence,
  type ValidatorStage,
  type Verdict,
} from "../protocol/index.ts";
import { CANCELLED, cancelledAround, unlessCancelled, type RunCancel } from "./cancel.ts";
import type { Clock } from "./clock.ts";

/** Keeps the ledger bounded: only the tail of a longer output is recorded. */
const MAX_OUTPUT_CHARS = 64 * 1024;

/** Stops a verification command when the run is cancelled. */
export interface CommandCancel extends RunCancel {
  clock: Clock;
  /** Records that the run is being cancelled, before the command is stopped. */
  beforeStop: () => Promise<void>;
}

/**
 * Runs the workflow's verification command through the system shell in `worktree`.
 * The evidence records the exit code; exit code 0 is a pass. If the run is cancelled meanwhile, the command and
 * everything it started are stopped, and this throws: a stopped command has no result. So does a command that failed
 * just as the run was cancelled, since the cancel may be why it failed.
 */
export async function runVerificationCommand(command: string, worktree: string, cancel?: CommandCancel): Promise<TestOutputEvidence> {
  if (cancel?.signal?.aborted) throw new Error("the run was cancelled, so the command was not started");
  const launchedAt = Date.now();
  // In a process group of its own on Linux and macOS, like an agent, so a cancel can stop everything it started.
  const child = spawn(command, { cwd: worktree, shell: true, detached: OWN_PROCESS_GROUP, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let truncated = false;
  const collect = (chunk: string) => {
    output += chunk;
    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(-MAX_OUTPUT_CHARS);
      truncated = true;
    }
  };
  // Decoding per stream keeps multi-byte characters intact across chunk boundaries.
  child.stdout.setEncoding("utf8").on("data", collect);
  child.stderr.setEncoding("utf8").on("data", collect);
  let hasExited = false;
  const closed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => (hasExited = true));
    child.once("close", (code, sig) => resolve({ exitCode: code, signal: sig }));
  });
  const ended = await unlessCancelled(closed, cancel?.signal);
  const failedAtCancel = ended !== CANCELLED && cancel !== undefined && (await cancelledAround(ended.exitCode === 0, cancel, cancel.clock));
  if (ended === CANCELLED || failedAtCancel) {
    await cancel!.beforeStop();
    const termination =
      child.pid === undefined ? null : await terminateTree({ pid: child.pid, launchedAt, hasExited: () => hasExited }, { graceMs: cancel!.graceMs });
    const what = failedAtCancel
      ? "the run was cancelled as the command failed, which may be why it failed"
      : "the run was cancelled, so the command was stopped";
    const left = termination?.outcome === "unconfirmed" ? `; it could still be running: ${termination.detail}` : "";
    throw new Error(`${what}${left}`);
  }
  const { exitCode, signal } = ended;
  return { kind: "test_output", command, exitCode, signal, output, truncated };
}

const MAX_INSTALL_OUTPUT_CHARS = 1500;

/** Runs the install command in the verification worktree; throws, with the end of its output, if it does not exit 0. */
export async function installDependencies(command: string, worktree: string, cancel?: CommandCancel): Promise<void> {
  const result = await runVerificationCommand(command, worktree, cancel);
  if (result.exitCode === 0) return;
  const ended = result.exitCode !== null ? `exited with code ${result.exitCode}` : `ended on signal ${result.signal}`;
  throw new Error(`install command "${command}" ${ended}:
${result.output.slice(-MAX_INSTALL_OUTPUT_CHARS)}`);
}

/** Checks the attempt's reported output against the step's required output fields. */
export function checkRequiredOutputFields(
  required: readonly string[],
  reported: Readonly<Record<string, unknown>>,
): RequiredOutputFieldsEvidence {
  return {
    kind: "required_output_fields",
    required: [...required],
    missing: required.filter((name) => !isPresentOutputField(reported[name])),
  };
}

/**
 * Exit codes by which the shell, or a validator that knows it is broken, says the command could not be run:
 * 126 (found but not executable) and 127 (not found). Together with a process that ended on a signal they are
 * the only evidence that the validator, not the attempt, is at fault. Any other non-zero exit is a failure. On
 * Windows the shell reports a missing command as exit code 1 and a killed process without a signal, so there
 * neither can be told from failing tests.
 */
const VALIDATOR_BROKEN_EXIT_CODES = [126, 127];

/** What one evidence item says about the attempt. */
export function evidenceVerdict(item: EvidenceItem): Verdict {
  switch (item.kind) {
    case "test_output":
      if (item.exitCode === 0) return "pass";
      return item.exitCode === null || VALIDATOR_BROKEN_EXIT_CODES.includes(item.exitCode) ? "inconclusive" : "fail";
    case "validator_error":
      return "inconclusive";
    case "required_output_fields":
      return item.missing.length === 0 ? "pass" : "fail";
    case "diff_scope":
      return "pass";
    case "protected_paths":
      return item.violations.length === 0 ? "pass" : "fail";
  }
}

/**
 * Verification passes only if every evidence item passes; with no evidence there is nothing to pass on. One
 * failing item fails it, even if another check could not run: a failure is a finding about the attempt. Short of
 * that, an item that could not reach a result leaves the verdict `inconclusive`, never pass.
 */
export function verdictOf(evidence: readonly EvidenceItem[]): Verdict {
  if (evidence.length === 0) throw new Error("verification produced no evidence");
  const verdicts = evidence.map(evidenceVerdict);
  if (verdicts.includes("fail")) return "fail";
  return verdicts.includes("inconclusive") ? "inconclusive" : "pass";
}

const MAX_ERROR_CHARS = 2000;

/** What a thrown value says, for evidence and the ledger. */
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Evidence that AHP could not run `stage` of the verification, for whatever error stopped it. */
export function validatorError(stage: ValidatorStage, error: unknown): ValidatorErrorEvidence {
  return { kind: "validator_error", stage, message: messageOf(error).slice(0, MAX_ERROR_CHARS) };
}
