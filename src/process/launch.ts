import type { Readable, Writable } from "node:stream";
import { execa } from "execa";
import { isFile, startsDirectly, type Executable } from "./resolve.ts";
import { OWN_PROCESS_GROUP, terminateTree, type TerminateOptions, type Termination } from "./tree.ts";

export interface LaunchOptions {
  /** What `resolveExecutable` found. */
  executable: Executable;
  /** The command's own arguments, passed as they are: no shell ever reads them. A prompt goes in `input`, never here. */
  args?: string[];
  cwd: string;
  /** Written to the process's stdin, byte for byte, which is then closed: the prompt, or whatever the tool reads there. Default empty. */
  input?: string;
  /**
   * Keeps stdin open and hands it to the caller (`LaunchedProcess.stdin`), for a tool that is talked to over the
   * process's lifetime, as an ACP agent is: the caller ends it, which is how such a tool is told to finish. `input` is
   * then not allowed. Resolution, `PWD` and the tree's termination are the same.
   */
  duplex?: boolean;
  /** Variables added to this process's environment. `PWD` is always `cwd`. */
  env?: NodeJS.ProcessEnv;
}

export interface ProcessExit {
  exitCode: number | null;
  signal: string | null;
}

export interface LaunchedProcess {
  pid: number;
  /** The process's stdin when it was launched `duplex`, else null (it was written and closed at launch). */
  stdin: Writable | null;
  /** The process's stdout, which the caller must read to the end. */
  stdout: Readable;
  /** Settles once the process has exited and its stdout has closed. */
  exited: Promise<ProcessExit>;
  /** Stops the process and everything it started, and says whether that was confirmed. */
  terminate(options?: TerminateOptions): Promise<Termination>;
}

/**
 * Starts a resolved executable with no shell, in a process group of its own on Linux and macOS (so it and everything
 * it starts can be signalled together, and Ctrl+C in the terminal reaches AHP alone), and hidden from the console on
 * Windows. Resolves once the process has spawned.
 *
 * On Windows the process shares AHP's console: detaching it would leave it with none, and console programs it starts
 * would then lose their output. So Ctrl+C in that console reaches the agent too; the cancel still kills whatever of
 * its tree is left and confirms it gone.
 */
export async function launch(options: LaunchOptions): Promise<LaunchedProcess> {
  const { executable } = options;
  if (options.duplex && options.input !== undefined) throw new Error("a duplex process is written to by its caller: it takes no `input`");
  // execa hands anything it cannot resolve to an .exe or .com to cmd.exe, a missing file included, so only an
  // existing .exe or .com may get there.
  if (process.platform === "win32" && !(startsDirectly(executable.file) && (await isFile(executable.file)))) {
    throw new Error(`could not start ${executable.file}: on Windows only an existing .exe or .com is started, never through cmd.exe`);
  }
  const launchedAt = Date.now();
  const subprocess = execa(executable.file, [...executable.prefixArgs, ...(options.args ?? [])], {
    cwd: options.cwd,
    // PWD is set too: a tool that follows the inherited PWD instead of its real working directory (OpenCode does) would
    // otherwise work in the directory AHP was started from, which silently defeats workspace isolation.
    env: { ...options.env, PWD: options.cwd },
    shell: false,
    detached: OWN_PROCESS_GROUP,
    // AHP stops the process itself, through `terminate`, and records how.
    cleanup: false,
    forceKillAfterDelay: false,
    reject: false,
    buffer: false,
    windowsHide: true,
    // No input still closes stdin, so a tool that reads it sees its end rather than waiting. A duplex process's stdin is the caller's.
    ...(options.duplex ? { stdin: "pipe" as const } : { input: options.input ?? "" }),
    stdout: "pipe",
    stderr: "ignore",
  });
  let hasExited = false;
  const exited = subprocess.then((result) => {
    hasExited = true;
    return result;
  });
  const spawned = new Promise<null>((resolve) => subprocess.nodeChildProcess.once("spawn", () => resolve(null)));
  const failed = await Promise.race([spawned, exited]);
  if (failed !== null || subprocess.pid === undefined) {
    throw new Error(`could not start ${executable.file}: ${failed?.originalMessage ?? failed?.shortMessage ?? "no process"}`, {
      cause: failed?.cause,
    });
  }
  const pid = subprocess.pid;
  return {
    pid,
    stdin: options.duplex ? subprocess.stdin : null,
    stdout: subprocess.stdout,
    exited: exited.then((result) => {
      if (result.failed && result.exitCode === undefined && result.signal === undefined) {
        throw new Error(`lost track of ${executable.file} (PID ${pid}): ${result.originalMessage ?? result.shortMessage}`, { cause: result.cause });
      }
      return { exitCode: result.exitCode ?? null, signal: result.signal ?? null };
    }),
    terminate: (terminateOptions) => terminateTree({ pid, launchedAt, hasExited: () => hasExited }, terminateOptions),
  };
}
