import { spawn } from "node:child_process";
import type { TestOutputEvidence, VerificationState } from "../protocol/index.ts";

/** Keeps the ledger bounded: only the tail of a longer output is recorded. */
const MAX_OUTPUT_CHARS = 64 * 1024;

export interface VerificationResult {
  verdict: Exclude<VerificationState, "pending">;
  evidence: TestOutputEvidence;
}

/**
 * Runs the workflow's verification command through the system shell in `worktree`.
 * Exit code 0 is `pass`; anything else is `fail`.
 */
export async function runVerificationCommand(command: string, worktree: string): Promise<VerificationResult> {
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
  return {
    verdict: exitCode === 0 ? "pass" : "fail",
    evidence: { kind: "test_output", command, exitCode, signal, output, truncated },
  };
}
