import { isRunning } from "./process.ts";

/** Processes a test's adapter left running, to be killed before the test's directories are removed (Windows cannot remove a running process's directory). */
const leftovers: number[] = [];

export const leaveRunning = (...pids: number[]) => void leftovers.push(...pids);

export function cleanupConformance(): void {
  for (const pid of leftovers.splice(0)) {
    if (isRunning(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone in the meantime
      }
    }
  }
}
