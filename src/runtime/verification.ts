import { spawn } from "node:child_process";
import {
  isPresentOutputField,
  type EvidenceItem,
  type RequiredOutputFieldsEvidence,
  type TestOutputEvidence,
  type VerificationState,
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

function evidencePasses(item: EvidenceItem): boolean {
  switch (item.kind) {
    case "test_output":
      return item.exitCode === 0;
    case "required_output_fields":
      return item.missing.length === 0;
  }
}

/** Verification passes only if every evidence item passes; with no evidence there is nothing to pass on. */
export function verdictOf(evidence: readonly EvidenceItem[]): Exclude<VerificationState, "pending"> {
  if (evidence.length === 0) throw new Error("verification produced no evidence");
  return evidence.every(evidencePasses) ? "pass" : "fail";
}
