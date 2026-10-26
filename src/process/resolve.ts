import { access, constants, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";

/**
 * How to start a command without a shell: the file to spawn and the arguments that go before the command's own.
 * On Windows `file` is always an `.exe` or `.com`, the only files Windows starts without `cmd.exe`.
 */
export interface Executable {
  file: string;
  /** For an npm shim, the JavaScript entry point that the current Node runs; otherwise empty. */
  prefixArgs: string[];
  /** `executable` when the command is a real binary (or, on Linux and macOS, a script the kernel starts); `npm_shim` when it is an npm `.cmd` shim, read but never run. */
  via: "executable" | "npm_shim";
  /** The file found on PATH. */
  path: string;
}

export interface ResolveOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`; a test can read a Windows layout anywhere. */
  platform?: NodeJS.Platform;
}

/**
 * The command cannot be started without a shell: it is not on PATH, or what is there is a `.cmd` or `.bat` that is not
 * an npm shim for Node. The message says what was searched, for the user and for `ahp doctor`.
 */
export class ExecutableNotFoundError extends Error {
  override name = "ExecutableNotFoundError";
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.command = command;
  }
}

/** The files Windows starts directly; everything else in PATHEXT needs `cmd.exe` or another host. */
const DIRECT = [".com", ".exe"];
/** The batch files AHP reads as npm shims, and never runs. */
const BATCH = [".bat", ".cmd"];

/**
 * Finds the real file to start for `command`, as a shell would find it on PATH, without ever going through one. On
 * Windows PATH is searched with PATHEXT, directory by directory: a real `.exe` or `.com` is used as it is, and an npm
 * `.cmd` shim is read to find the JavaScript entry point it would hand to Node, which the current Node runs instead.
 * Any other `.cmd` or `.bat` is refused: AHP never runs one through `cmd.exe`, where a prompt could become commands.
 */
export async function resolveExecutable(command: string, options: ResolveOptions = {}): Promise<Executable> {
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === "win32";
  return windows ? resolveOnWindows(command, env) : resolveOnPosix(command, env);
}

function pathEntries(env: NodeJS.ProcessEnv, separator: string): string[] {
  // Windows names its variables without regard to case.
  const value = env.PATH ?? env.Path ?? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  return value
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "");
}

const directories = (n: number) => (n === 1 ? "1 directory" : `${n} directories`);

async function resolveOnPosix(command: string, env: NodeJS.ProcessEnv): Promise<Executable> {
  const candidates = command.includes("/") ? [command] : pathEntries(env, ":").map((dir) => join(dir, command));
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return { file: candidate, prefixArgs: [], via: "executable", path: candidate };
  }
  const where = command.includes("/") ? "is not an executable file" : `is not on PATH (${directories(candidates.length)} searched)`;
  throw new ExecutableNotFoundError(command, `"${command}" ${where}`);
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveOnWindows(command: string, env: NodeJS.ProcessEnv): Promise<Executable> {
  const pathExt = (env.PATHEXT ?? Object.entries(env).find(([key]) => key.toUpperCase() === "PATHEXT")?.[1] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext !== "");
  // Only what can be started without cmd.exe, or read as a shim: .ps1, .js and .vbs need hosts of their own.
  const extensions = [...DIRECT, ...BATCH].filter((ext) => pathExt.includes(ext));
  const explicit = [...DIRECT, ...BATCH].find((ext) => command.toLowerCase().endsWith(ext));
  const hasDirectory = command.includes("\\") || command.includes("/") || win32.isAbsolute(command);
  const dirs = hasDirectory ? [""] : pathEntries(env, ";");
  for (const dir of dirs) {
    for (const ext of explicit ? [""] : extensions) {
      const candidate = dir === "" ? `${command}${ext}` : join(dir, `${command}${ext}`);
      if (!(await isFile(candidate))) continue;
      if (DIRECT.some((direct) => candidate.toLowerCase().endsWith(direct))) {
        return { file: candidate, prefixArgs: [], via: "executable", path: candidate };
      }
      return readShim(command, candidate);
    }
  }
  const searched = hasDirectory ? "does not exist" : `is not on PATH (${directories(dirs.length)} searched, with extensions ${extensions.join(", ")})`;
  throw new ExecutableNotFoundError(command, `"${command}" ${searched}`);
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The last quoted `%dp0%\…` or `%~dp0\…` path on the line that passes the shim's arguments on (`%*`): the file the shim
 * starts, relative to the shim's own directory.
 */
const SHIM_TARGET = /"%~?dp0%?\\([^"]+)"/g;

/** What an npm shim starts: its target run directly when it is an `.exe`, or by the current Node when the shim runs it with Node. */
async function readShim(command: string, shim: string): Promise<Executable> {
  const refuse = (why: string) =>
    new ExecutableNotFoundError(command, `"${command}" resolves to ${shim}, ${why}; AHP never runs a .cmd or .bat file through cmd.exe`);
  const content = await readFile(shim, "utf8");
  const launchLine = content.split(/\r?\n/).findLast((line) => line.includes("%*"));
  const target = launchLine ? [...launchLine.matchAll(SHIM_TARGET)].map((match) => match[1]!).findLast((path) => !/^node(\.exe)?$/i.test(path)) : undefined;
  if (!target) throw refuse("which is not an npm shim (no target it passes its arguments to)");
  const entry = join(shim, "..", ...target.split("\\"));
  if (!(await isFile(entry))) throw refuse(`an npm shim whose entry point ${entry} does not exist`);
  if (DIRECT.some((direct) => entry.toLowerCase().endsWith(direct))) return { file: entry, prefixArgs: [], via: "npm_shim", path: shim };
  // npm's shim for a JavaScript bin runs it with node.exe beside the shim or the Node on PATH: the current Node does instead.
  if (!/(^|[\s"\\=])node(\.exe)?["\s]/im.test(content)) throw refuse(`which is not an npm shim for Node (it does not run ${target} with node)`);
  return { file: process.execPath, prefixArgs: [entry], via: "npm_shim", path: shim };
}

/** Whether `file` is one Windows starts without `cmd.exe`. */
export const startsDirectly = (file: string) => isAbsolute(file) && DIRECT.some((ext) => file.toLowerCase().endsWith(ext));
