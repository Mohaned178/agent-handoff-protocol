import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { CancelPath } from "../protocol/index.ts";

export interface TerminateOptions {
  /**
   * The transport's own way to stop the agent (an ACP `session/cancel`), for an adapter that declares one. Tried
   * first, instead of SIGTERM; the process tree is killed if it has not ended within the grace period after it.
   */
  graceful?: () => Promise<void>;
  /** How long a graceful stop (the transport's, or SIGTERM on Linux and macOS) is given. Default `DEFAULT_GRACE_MS`. */
  graceMs?: number;
  /** How long the tree is given to be gone after it was killed, before the kill counts as unconfirmed. Default 10000 ms. */
  confirmMs?: number;
}

/**
 * How stopping a process tree ended:
 * - `already_gone`: every process of the tree had ended by itself before anything was sent to it.
 * - `stopped`: every process was seen gone after `via` stopped them; `forced` when it took a kill.
 * - `unconfirmed`: some process could still be running; `survivors` are their PIDs (the group's, on Linux and macOS).
 */
export type Termination =
  | { outcome: "already_gone" }
  | { outcome: "stopped"; forced: boolean; via: CancelPath }
  | { outcome: "unconfirmed"; survivors: number[]; detail: string };

/** The process that heads the tree: its PID, when it was started, and whether it has exited. */
export interface TreeRoot {
  pid: number;
  /** Epoch milliseconds, taken just before it was spawned. */
  launchedAt: number;
  hasExited: () => boolean;
}

/** How long a graceful stop is given before the tree is killed, unless the caller says otherwise. */
export const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_CONFIRM_MS = 10_000;
const POLL_MS = 100;

/**
 * Whether a process the process layer starts leads a process group of its own, which holds everything it starts:
 * on Linux and macOS. On Windows it would also be left without a console, and console programs it starts would lose
 * their output, so there the tree is read from parent PIDs instead.
 */
export const OWN_PROCESS_GROUP = process.platform !== "win32";

/**
 * Stops a process tree started by the process layer, and confirms that it has gone. On Linux and macOS the root leads
 * its own process group, which holds the tree: the transport's stop if there is one, else SIGTERM to the group, then,
 * after the grace period, SIGKILL to the group. On Windows a process cannot be asked to stop without a console of its
 * own, so after the transport's stop, if any, the tree (read from the parent PIDs of every process) is killed
 * outright with `taskkill /T /F`, which is always forced.
 */
export async function terminateTree(root: TreeRoot, options: TerminateOptions = {}): Promise<Termination> {
  const resolved = { graceful: options.graceful, graceMs: options.graceMs ?? DEFAULT_GRACE_MS, confirmMs: options.confirmMs ?? DEFAULT_CONFIRM_MS };
  return process.platform === "win32" ? terminateOnWindows(root, resolved) : terminateGroup(root, resolved);
}

type ResolvedOptions = Required<Pick<TerminateOptions, "graceMs" | "confirmMs">> & Pick<TerminateOptions, "graceful">;

/** Polls `gone` until it is true or `ms` have passed; returns its last answer. */
async function goneWithin(ms: number, gone: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await gone()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/** Asks the transport to stop the agent; false when there is no transport stop or it could not be delivered. */
async function tryGraceful(graceful: (() => Promise<void>) | undefined): Promise<boolean> {
  if (!graceful) return false;
  try {
    await graceful();
    return true;
  } catch {
    return false;
  }
}

/** Whether signal 0 reaches `target` (a PID, or minus a process group's ID): it checks without sending anything. */
function answers(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // EPERM: something is there that this process may not signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const execFileText = (file: string, args: string[]) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout });
    });
  });

// ---------------------------------------------------------------------------
// Linux and macOS: the root's process group

/**
 * Whether any process of the group is still running. Signal 0 to the group answers while a member is a zombie (or,
 * on macOS, refuses with EPERM), and a zombie waits only for its parent to reap it: `ps` tells the two apart.
 */
async function groupAlive(pgid: number): Promise<boolean> {
  if (!answers(-pgid)) return false;
  const { code, stdout } = await execFileText("ps", ["-A", "-o", "pgid=,stat="]);
  // Without ps, signal 0's answer is all there is.
  if (code !== 0) return true;
  return stdout.split("\n").some((line) => {
    const [group, stat] = line.trim().split(/\s+/);
    return Number(group) === pgid && stat !== undefined && !stat.startsWith("Z");
  });
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function terminateGroup(root: TreeRoot, { graceful, graceMs, confirmMs }: ResolvedOptions): Promise<Termination> {
  const pgid = root.pid;
  const gone = async () => !(await groupAlive(pgid));
  if (await gone()) return { outcome: "already_gone" };
  // The transport's stop takes SIGTERM's place: the agent gets one grace period, not two.
  if (await tryGraceful(graceful)) {
    if (await goneWithin(graceMs, gone)) return { outcome: "stopped", forced: false, via: "transport" };
  } else {
    signalGroup(pgid, "SIGTERM");
    if (await goneWithin(graceMs, gone)) return { outcome: "stopped", forced: false, via: "signal" };
  }
  signalGroup(pgid, "SIGKILL");
  if (await goneWithin(confirmMs, gone)) return { outcome: "stopped", forced: true, via: "tree_kill" };
  return { outcome: "unconfirmed", survivors: [pgid], detail: `processes of group ${pgid} were still running ${confirmMs} ms after SIGKILL` };
}

// ---------------------------------------------------------------------------
// Windows: the tree by parent PID

interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Creation time, epoch milliseconds; with the PID it tells a process apart from a later one given the same PID. */
  created: number;
}

/** Every process on the machine, with its parent and creation time, read through CIM. */
async function processTable(): Promise<Map<number, ProcessEntry>> {
  const script =
    "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { " +
    '"$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 })" }';
  const { code, stdout } = await execFileText("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
  if (code !== 0) throw new Error(`could not list processes (powershell exited ${code})`);
  const table = new Map<number, ProcessEntry>();
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, ppid, created] = line.trim().split(" ").map(Number);
    if (pid !== undefined && ppid !== undefined && created !== undefined && Number.isInteger(pid)) table.set(pid, { pid, ppid, created });
  }
  return table;
}

/**
 * The root and every process descended from it. A child counts only if it was created after its parent, since a
 * parent PID can name a process that has exited and whose PID went to an unrelated one; a root that has exited is
 * left out, and its children count if they were created after it was launched.
 */
function treeOf(root: TreeRoot, rootAlive: boolean, table: Map<number, ProcessEntry>): ProcessEntry[] {
  const tree: ProcessEntry[] = [];
  const rootEntry = table.get(root.pid);
  // Allow for the clock's resolution: the root's creation time can read a little before it was launched.
  const since = root.launchedAt - 2_000;
  if (rootAlive && rootEntry && rootEntry.created >= since) tree.push(rootEntry);
  const queue: { pid: number; created: number }[] = [{ pid: root.pid, created: rootAlive && rootEntry ? rootEntry.created : since }];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const entry of table.values()) {
      if (entry.ppid !== parent.pid || entry.pid === parent.pid || entry.created < parent.created) continue;
      if (tree.some((known) => known.pid === entry.pid)) continue;
      tree.push(entry);
      queue.push(entry);
    }
  }
  return tree;
}

async function terminateOnWindows(root: TreeRoot, { graceful, graceMs, confirmMs }: ResolvedOptions): Promise<Termination> {
  const tree = treeOf(root, !root.hasExited(), await processTable());
  const gone = () => tree.every((entry) => !answers(entry.pid));
  if (gone()) return { outcome: "already_gone" };
  if ((await tryGraceful(graceful)) && (await goneWithin(graceMs, gone))) return { outcome: "stopped", forced: false, via: "transport" };
  // taskkill reports the PIDs it no longer finds; what counts is whether the tree has gone afterwards.
  await execFileText("taskkill.exe", ["/F", "/T", ...tree.flatMap((entry) => ["/PID", String(entry.pid)])]);
  if (await goneWithin(confirmMs, gone)) return { outcome: "stopped", forced: true, via: "tree_kill" };
  // A PID still answering may have gone to a new process already: only one with the same creation time survived.
  const now = await processTable();
  const survivors = tree.filter((entry) => answers(entry.pid) && now.get(entry.pid)?.created === entry.created).map((entry) => entry.pid);
  if (survivors.length === 0) return { outcome: "stopped", forced: true, via: "tree_kill" };
  return { outcome: "unconfirmed", survivors, detail: `PIDs ${survivors.join(", ")} were still running ${confirmMs} ms after taskkill /T /F` };
}
