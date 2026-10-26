import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));

/** Polls `check` until it returns a value. */
export async function until<T>(check: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until no process has `pid`: a PID the OS has already handed to another process rightly reads as running. */
export const untilGone = (pid: number, what: string) => until(() => (isRunning(pid) ? undefined : true), what);

/** `ahp run` started as a child process in `cwd`, for a test to watch and kill. */
export const startRun = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => startAhp(["run", ...args], cwd, env);

/** An `ahp` command started as a child process in `cwd`, for a test to watch and kill. */
export function startAhp(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return {
    child,
    pid: child.pid!,
    /** Settles with the exit code once `ahp run` has exited. */
    exited,
    stdout: () => stdout,
    /** The run's ID, once `ahp run` has printed it. */
    runId: () =>
      until(() => {
        if (child.exitCode !== null) throw new Error(`ahp run exited early:\n${stdout}`);
        return /run (run_[a-z0-9]+): created/.exec(stdout)?.[1];
      }, "ahp run to create its run"),
    /** Kills the runtime, and only it, as a crash or a power cut would stop it, and waits until its PID is free. */
    kill: async () => {
      child.kill("SIGKILL");
      await exited;
      await untilGone(child.pid!, "the killed runtime's PID to be free");
    },
  };
}
