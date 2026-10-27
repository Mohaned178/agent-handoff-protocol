import { ExecutableNotFoundError, launch, resolveExecutable, type Executable } from "../process/index.ts";
import { systemClock, type Clock } from "../runtime/clock.ts";

/** How long a status or version command is given before it is stopped. */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
/** The most output of a command that is kept; the rest is read and thrown away. */
const MAX_OUTPUT = 16 * 1024;

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  timeoutMs?: number;
  /** Where the command runs: never the user's repository. */
  cwd: string;
}

export type ProbeResult =
  | { outcome: "not_found"; message: string }
  | { outcome: "failed"; message: string }
  | { outcome: "timed_out"; message: string }
  | { outcome: "exited"; exitCode: number | null; signal: string | null; path: string; stdout: string };

/**
 * Runs `command` once through the shared process layer (resolved on PATH, no shell, nothing on stdin) and reports how
 * it ended. A command that does not end within the timeout is stopped with its whole process tree. The output is kept
 * only up to a limit, for the caller to read what it needs from and drop.
 */
export async function probe(command: string, args: string[], options: ProbeOptions): Promise<ProbeResult> {
  const clock = options.clock ?? systemClock;
  let executable: Executable;
  try {
    executable = await resolveExecutable(command, { env: options.env });
  } catch (error) {
    if (error instanceof ExecutableNotFoundError) return { outcome: "not_found", message: error.message };
    return { outcome: "failed", message: (error as Error).message };
  }
  let child;
  try {
    child = await launch({ executable, args, cwd: options.cwd, env: options.env });
  } catch (error) {
    return { outcome: "failed", message: (error as Error).message };
  }
  let stdout = "";
  const reading = (async () => {
    for await (const chunk of child.stdout as AsyncIterable<Buffer | string>) {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
    }
  })().catch(() => undefined);

  const waiting = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const timedOut = clock.sleep(timeoutMs, waiting.signal).then(
    () => "timed_out" as const,
    () => "settled" as const,
  );
  const ended = child.exited.then(
    (exit) => exit,
    (error: Error) => error,
  );
  const first = await Promise.race([timedOut, ended]);
  waiting.abort();
  if (first === "timed_out") {
    const termination = await child.terminate();
    await reading;
    const confirmed = termination.outcome === "unconfirmed" ? "and could not be confirmed stopped" : "and stopped";
    return { outcome: "timed_out", message: `did not finish within ${timeoutMs} ms ${confirmed}` };
  }
  const exit = await ended;
  await reading;
  if (exit instanceof Error) return { outcome: "failed", message: exit.message };
  return { outcome: "exited", exitCode: exit.exitCode, signal: exit.signal, path: executable.path, stdout: stdout.slice(0, MAX_OUTPUT) };
}

/** The first non-blank line of `text`, trimmed and cut to a length that fits a terminal; null for none. */
export function firstLine(text: string, max = 120): string | null {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "");
  return line === undefined ? null : line.trim().slice(0, max);
}
