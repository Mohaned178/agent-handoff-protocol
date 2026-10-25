import { spawn } from "node:child_process";
import {
  isPresentOutputField,
  type EvidenceItem,
  type RequiredOutputFieldsEvidence,
  type TestOutputEvidence,
  type ValidatorErrorEvidence,
  type ValidatorStage,
  type Verdict,
} from "../protocol/index.ts";

/** Keeps the ledger bounded: only the tail of a longer output is recorded. */
const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * Runs the workflow's verification command through the system shell in `worktree`.
 * The evidence records the exit code; exit code 0 is a pass.
 */
export async function runVerificationCommand(command: string, worktree: string): Promise<TestOutputEvidence> {
  const child = spawn(command, { cwd: worktree, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
  const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, sig) => resolve({ exitCode: code, signal: sig }));
    },
  );
  return { kind: "test_output", command, exitCode, signal, output, truncated };
}

const MAX_INSTALL_OUTPUT_CHARS = 1500;

/** Runs the install command in the verification worktree; throws, with the end of its output, if it does not exit 0. */
export async function installDependencies(command: string, worktree: string): Promise<void> {
  const result = await runVerificationCommand(command, worktree);
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

/** Evidence that AHP could not run `stage` of the verification, for whatever error stopped it. */
export function validatorError(stage: ValidatorStage, error: unknown): ValidatorErrorEvidence {
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "validator_error", stage, message: message.slice(0, MAX_ERROR_CHARS) };
}
