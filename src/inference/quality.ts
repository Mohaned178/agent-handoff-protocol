// The `quality` workload's scoring: the code block of an answer is written beside the prompt's `test.mjs` and run with
// `node --test`. This runs model-written code on the host, with a time limit and the whole process tree stopped on expiry; it is
// not a sandbox (docs/limits.md says the same of verification).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, type Executable, type Termination } from "../process/index.ts";
import { sha256Of } from "./bench.ts";
import type { ScoreResult } from "./score.ts";

/** What a coding answer is scored as: its tests pass, fail, it has no JavaScript code block, or its tests did not finish in time. */
export const QUALITY_OUTCOMES = ["pass", "fail", "no_code", "timed_out"] as const;
export type QualityOutcome = (typeof QUALITY_OUTCOMES)[number];

/** The file names an answer's code and the test are written under; a `test.mjs` imports `./solution.mjs`. */
export const SOLUTION_FILE = "solution.mjs";
export const TEST_FILE = "test.mjs";

/** The languages of a fenced block that are taken as JavaScript; a block with none named is too. */
const JAVASCRIPT = new Set(["", "js", "javascript", "mjs", "node"]);

const OPENING = /^ {0,3}```\s*([^\s`]*)[^`]*$/;
const CLOSING = /^ {0,3}```\s*$/;

export interface CodeBlock {
  code: string;
  /** False when the answer ended inside the block (cut off by `max_tokens`): the code is what was written. */
  closed: boolean;
}

/**
 * The first fenced block of the answer that is JavaScript (no language named, or js, javascript, mjs, node); a block in another
 * language is not code to test. A block the answer never closes is taken as far as it goes. Null when there is none.
 */
export function extractCode(text: string): CodeBlock | null {
  let open: { lang: string; lines: string[] } | null = null;
  const take = (block: { lang: string; lines: string[] }, closed: boolean): CodeBlock | null => (JAVASCRIPT.has(block.lang.toLowerCase()) ? { code: `${block.lines.join("\n")}\n`, closed } : null);
  for (const line of text.split(/\r?\n/)) {
    if (open === null) {
      const opening = OPENING.exec(line);
      if (opening) open = { lang: opening[1]!, lines: [] };
    } else if (CLOSING.test(line)) {
      const found = take(open, true);
      if (found) return found;
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  return open === null ? null : take(open, false);
}

export interface QualityScoreOptions {
  /** How long `node --test` may take before it is stopped and the answer is `timed_out` (default 20000 ms). */
  timeoutMs?: number;
  /** The `finish_reason` the engine gave, for the detail of an answer it cut off. */
  finishReason?: string | null;
  /** The environment `node` runs in (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Aborting it stops the test run; the result is then a problem, not a verdict. */
  signal?: AbortSignal;
}

export const DEFAULT_TEST_TIMEOUT_MS = 20_000;
/** How long a stopped test run's tree is given to be seen gone before the stop counts as unconfirmed. */
const STOP_CONFIRM_MS = 5_000;
/** The problem a cancel leaves on an answer whose tests it stopped. */
export const CANCELLED_WHILE_TESTING = "cancelled while the tests ran";
const SHOWN = 300;
const KEPT_OUTPUT = 16 * 1024;

const NODE: Executable = { file: process.execPath, prefixArgs: [], via: "executable", path: process.execPath };

/** The first failing test's line and its error, from node's TAP output; else the last line printed. */
export function failureDetail(output: string): string | null {
  const lines = output.split(/\r?\n/);
  const failing = lines.findIndex((line) => /^\s*not ok\b/.test(line));
  if (failing === -1) return trim(lines.map((line) => line.trim()).filter((line) => line !== "").at(-1) ?? "");
  const error = lines.slice(failing + 1).find((line) => /^\s+error:/.test(line));
  return trim([lines[failing]!.trim(), error?.trim()].filter(Boolean).join(" | "));
}

const trim = (text: string) => (text === "" ? null : text.length > SHOWN ? `${text.slice(0, SHOWN - 3)}...` : text);

/**
 * Scores one answer: no JavaScript block is `no_code`; otherwise the block and the prompt's test are written to a fresh
 * temporary directory and `node --test` is run there, from the temporary directory and not the working one. Exit code 0 is
 * `pass`, any other `fail` (a syntax error in the block included), and a run that outlives the limit `timed_out`.
 */
export async function scoreQuality(content: string, test: string, options: QualityScoreOptions = {}): Promise<ScoreResult> {
  const block = extractCode(content);
  if (!block) return { score: { outcome: "no_code", detail: null, codeSha256: null }, problem: null };
  const codeSha256 = sha256Of(block.code);
  const cutOff = !block.closed ? (options.finishReason === "length" ? "the answer was cut off at max_tokens inside the code block" : "the code block was never closed") : null;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "ahp-bench-"));
    await writeFile(join(dir, SOLUTION_FILE), block.code);
    await writeFile(join(dir, TEST_FILE), test);
    const child = await launch({ executable: NODE, args: ["--test", "--test-reporter=tap", TEST_FILE], cwd: dir, env: options.env });
    let output = "";
    const reading = (async () => {
      for await (const chunk of child.stdout as AsyncIterable<Buffer | string>) if (output.length < KEPT_OUTPUT) output += chunk.toString();
    })().catch(() => undefined);
    // A stop is started by the limit or by a cancel, whichever comes first, and its outcome is read: a tree that is not seen gone
    // is a problem, not a wait without end, and a failed `terminate` is caught here rather than left unhandled.
    const stop: { why: "timeout" | "cancelled" | null; ended: Promise<Termination | null> | null } = { why: null, ended: null };
    let trigger!: () => void;
    const triggered = new Promise<void>((resolve) => (trigger = resolve));
    const stopFor = (why: "timeout" | "cancelled") => {
      if (stop.why !== null) return;
      stop.why = why;
      stop.ended = child.terminate({ graceMs: 500, confirmMs: STOP_CONFIRM_MS }).then(
        (termination) => termination,
        () => null,
      );
      trigger();
    };
    const timer = setTimeout(() => stopFor("timeout"), options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS);
    const onAbort = () => stopFor("cancelled");
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const first = await Promise.race([
      child.exited.then(
        (result) => result,
        (error: Error) => error,
      ),
      triggered.then(() => "stopped" as const),
    ]);
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (first === "stopped") {
      const termination = await stop.ended!;
      // The output is complete once the tree is gone; a pipe held open by a survivor is not waited for.
      await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
      if (termination === null || termination.outcome === "unconfirmed") {
        return { score: null, problem: "the test run could not be stopped and confirmed gone" };
      }
      if (stop.why === "cancelled") return { score: null, problem: CANCELLED_WHILE_TESTING };
      return { score: { outcome: "timed_out", detail: trim(`the tests did not finish in ${options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS} ms`), codeSha256 }, problem: null };
    }
    const exit = first;
    await reading;
    if (exit instanceof Error) return { score: null, problem: `lost track of the test run: ${exit.message}` };
    if (exit.exitCode === 0) return { score: { outcome: "pass", detail: cutOff, codeSha256 }, problem: null };
    return { score: { outcome: "fail", detail: trim([failureDetail(output), cutOff].filter(Boolean).join(" ; ")), codeSha256 }, problem: null };
  } catch (error) {
    return { score: null, problem: `could not run the tests: ${(error as Error).message}`.slice(0, SHOWN) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}
