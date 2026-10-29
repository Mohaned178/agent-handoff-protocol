// An evaluation task: a directory holding everything one task needs, so freezing it is hashing the directory.
//
//   <task dir>/
//     task.json   the task: id, prompt, planted constraints, seeded defects, how its result is verified
//     repo/       the fixture repository's files: every trial starts from a fresh commit of exactly these
//     hidden/     the hidden tests: `hidden/<path>` is written at `<path>` in a verification worktree and nowhere else
//
// Anything else in the directory is frozen with the rest but used for nothing. The directory is read once into memory, so
// the bytes that were hashed are the bytes a trial uses.

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRepoPath, isStepId, NETWORK_STANCES, type HiddenTest, type NetworkStance } from "../protocol/index.ts";
import { compilePattern, CONSTRAINT_CHECK_KINDS, forbiddenPatternViolations, type ConstraintCheck, type ConstraintCheckKind } from "./checks.ts";
import type { FrozenFile } from "./events.ts";
import { byPath, fileListOf, hashOfFiles } from "./freeze.ts";

export interface TaskConstraint {
  id: string;
  /** What the first agent is told, in the words it receives it in. Only the first step of a condition is told it. */
  statement: string;
  check: ConstraintCheck;
}

/** A defect the fixture is known to contain, for review evaluation; frozen with the task and not scored by ticket 20. */
export interface SeededDefect {
  id: string;
  description: string;
  /** A file of the fixture the defect is in. */
  path: string;
}

export interface EvaluationTask {
  id: string;
  /** The task as the first agent of every condition is told it. */
  prompt: string;
  constraints: TaskConstraint[];
  seededDefects: SeededDefect[];
  verification: {
    /** Run through the system shell in a verification worktree, with the hidden tests in place; exit code 0 is a pass. */
    command: string;
    /** Run before `command`, to install dependencies; a failing install is a validator that could not run. */
    install?: string;
    /**
     * The check a developer would have: run through the system shell on an agent's result, in a verification worktree with
     * no hidden tests in place (so over what the fixture holds, such as its visible tests), exit code 0 a pass. The
     * conditions with an acceptance check (C0V, C3min, C3) need it; the hidden tests reach no agent and no workflow.
     */
    acceptance?: string;
    /** Repository-relative paths no trial may change; the hidden tests' paths are protected as well. */
    protectedPaths: string[];
  };
  /** The network stance of every step of every condition: the same for a task in all of them. Default `deny`. */
  network: { stance: NetworkStance };
  /** The fixture repository's files, by path relative to `repo/`. */
  fixture: ReadonlyMap<string, Buffer>;
  hiddenTests: HiddenTest[];
}

/** A task directory read, validated and hashed. */
export interface LoadedTask {
  task: EvaluationTask;
  /** As given, so the hash can be taken again. */
  dir: string;
  /** Every file of the directory, by path. */
  files: FrozenFile[];
  /** The freeze hash of the whole directory. */
  hash: string;
  /** The freeze hash of the files under `hidden/`, by path relative to it. */
  hiddenTestsHash: string;
}

export class TaskInvalidError extends Error {
  override name = "TaskInvalidError";
  readonly problems: string[];
  constructor(dir: string, problems: string[]) {
    super(`invalid task ${dir}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.problems = problems;
  }
}

const TASK_KEYS = ["id", "prompt", "constraints", "seededDefects", "verification", "network"];
const VERIFICATION_KEYS = ["command", "install", "acceptance", "protectedPaths"];
const CONSTRAINT_KEYS = ["id", "statement", "check"];
const CHECK_KEYS: Record<ConstraintCheckKind, readonly string[]> = { forbidden_pattern: ["kind", "pattern", "flags", "paths"], required_invariant: ["kind", "command"] };
const DEFECT_KEYS = ["id", "description", "path"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonBlank = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Every file under `dir`, by path relative to it with `/` separators. A symbolic link, anything that is neither a file nor a
 * directory, and a `.git` anywhere are refused: a task is plain files, and a nested repository would not freeze as one.
 */
export async function readTaskFiles(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const problems: string[] = [];
  async function walk(absolute: string, relative: string): Promise<void> {
    for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => byPath(a.name, b.name))) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.name.toLowerCase() === ".git") problems.push(`${path}: a task holds plain files, not a git repository`);
      else if (entry.isSymbolicLink() || (await lstat(join(absolute, entry.name))).isSymbolicLink()) problems.push(`${path}: is a symbolic link`);
      else if (entry.isDirectory()) await walk(join(absolute, entry.name), path);
      else if (entry.isFile()) files.set(path, await readFile(join(absolute, entry.name)));
      else problems.push(`${path}: is neither a file nor a directory`);
    }
  }
  const root = await lstat(dir).catch(() => null);
  if (!root?.isDirectory()) throw new TaskInvalidError(dir, ["is not a directory"]);
  await walk(dir, "");
  if (problems.length > 0) throw new TaskInvalidError(dir, problems);
  return files;
}

/** Reads, validates and hashes the task directory `dir`; throws `TaskInvalidError` naming every problem. */
export async function loadTask(dir: string): Promise<LoadedTask> {
  return parseTask(dir, await readTaskFiles(dir));
}

/** Validates the files of a task directory, already read, and hashes them. */
export function parseTask(dir: string, files: ReadonlyMap<string, Buffer>): LoadedTask {
  const problems: string[] = [];
  const problem = (message: string) => problems.push(message);

  const under = (prefix: string) => new Map([...files].filter(([path]) => path.startsWith(prefix)).map(([path, bytes]) => [path.slice(prefix.length), bytes] as const));
  const fixture = under("repo/");
  const hidden = under("hidden/");
  if (fixture.size === 0) problem("`repo/` holds no files: it is the fixture repository every trial starts from");
  if (hidden.size === 0) problem("`hidden/` holds no files: a task needs hidden tests, the only thing a trial's success is scored by");

  const hiddenTests: HiddenTest[] = [];
  for (const [path, bytes] of [...hidden].sort(([a], [b]) => byPath(a, b))) {
    const content = bytes.toString("utf8");
    if (!isRepoPath(path)) problem(`hidden test ${JSON.stringify(path)} must be relative to the repository root, with no "." or ".." segments and no characters that are invalid in Windows paths`);
    else if (!Buffer.from(content).equals(bytes)) problem(`hidden test ${JSON.stringify(path)} is not UTF-8 text`);
    else hiddenTests.push({ path, content });
  }
  for (const path of fixture.keys()) {
    if (!isRepoPath(path)) problem(`fixture file ${JSON.stringify(path)} must be a repository-relative path with no "." or ".." segments and no characters that are invalid in Windows paths`);
  }

  let spec: unknown;
  const raw = files.get("task.json");
  if (!raw) problem("has no `task.json`");
  else {
    try {
      spec = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      problem(`\`task.json\` is not valid JSON: ${(error as Error).message}`);
    }
  }
  const task = isRecord(spec) ? taskOf(spec, fixture, hiddenTests, problem) : undefined;
  if (spec !== undefined && !isRecord(spec)) problem("`task.json` must be an object");
  if (problems.length > 0 || !task) throw new TaskInvalidError(dir, problems);

  const list = fileListOf(files);
  const hiddenList = fileListOf(hidden);
  return { task, dir, files: list, hash: hashOfFiles(list), hiddenTestsHash: hashOfFiles(hiddenList) };
}

/** The task a `task.json` describes, with its problems reported to `problem`; undefined when it is too broken to build. */
function taskOf(spec: Record<string, unknown>, fixture: ReadonlyMap<string, Buffer>, hiddenTests: HiddenTest[], problem: (message: string) => void): EvaluationTask | undefined {
  for (const key of Object.keys(spec)) if (!TASK_KEYS.includes(key)) problem(`unknown property \`${key}\` in task.json`);
  if (!isStepId(spec.id)) problem('task.json: `id` must be lowercase letters, digits, "-" or "_", starting with a letter or digit');
  if (!isNonBlank(spec.prompt)) problem("task.json: needs a non-empty `prompt`");

  const verification = spec.verification;
  let command = "";
  let install: string | undefined;
  let acceptance: string | undefined;
  let protectedPaths: string[] = [];
  if (!isRecord(verification)) problem("task.json: needs a `verification` object with a `command`");
  else {
    for (const key of Object.keys(verification)) if (!VERIFICATION_KEYS.includes(key)) problem(`unknown property \`verification.${key}\``);
    if (!isNonBlank(verification.command)) problem("task.json: needs a non-empty `verification.command`");
    else command = verification.command;
    if (verification.install !== undefined && !isNonBlank(verification.install)) problem("`verification.install` must be a non-empty string");
    else install = verification.install as string | undefined;
    if (verification.acceptance !== undefined && !isNonBlank(verification.acceptance)) problem("`verification.acceptance` must be a non-empty string");
    else acceptance = verification.acceptance as string | undefined;
    const paths = verification.protectedPaths;
    if (paths !== undefined && !(Array.isArray(paths) && paths.every(isRepoPath))) problem("`verification.protectedPaths` must be an array of repository-relative paths");
    else protectedPaths = (paths as string[] | undefined) ?? [];
  }

  let stance: NetworkStance = "deny";
  if (spec.network !== undefined) {
    const network = spec.network;
    if (!isRecord(network) || !NETWORK_STANCES.includes(network.stance as NetworkStance)) problem(`\`network\` must be an object with a \`stance\`: ${NETWORK_STANCES.join(", ")}`);
    else {
      for (const key of Object.keys(network)) if (key !== "stance") problem(`unknown property \`network.${key}\``);
      stance = network.stance as NetworkStance;
    }
  }

  const constraints = listOf(spec.constraints, "constraints", problem).flatMap((item, index) => constraintOf(item, index, fixture, problem));
  const seen = new Set<string>();
  for (const { id } of constraints) {
    if (seen.has(id)) problem(`constraint "${id}" is listed twice`);
    seen.add(id);
  }
  const seededDefects = listOf(spec.seededDefects, "seededDefects", problem).flatMap((item, index) => defectOf(item, index, fixture, problem));
  const defectIds = new Set<string>();
  for (const { id } of seededDefects) {
    if (defectIds.has(id)) problem(`seeded defect "${id}" is listed twice`);
    defectIds.add(id);
  }

  if (typeof spec.id !== "string" || typeof spec.prompt !== "string") return undefined;
  return { id: spec.id, prompt: spec.prompt, constraints, seededDefects, verification: { command, ...(install !== undefined ? { install } : {}), ...(acceptance !== undefined ? { acceptance } : {}), protectedPaths }, network: { stance }, fixture: fixture as ReadonlyMap<string, Buffer>, hiddenTests };
}

function listOf(value: unknown, name: string, problem: (message: string) => void): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problem(`\`${name}\` must be an array`);
    return [];
  }
  return value;
}

function constraintOf(item: unknown, index: number, fixture: ReadonlyMap<string, Buffer>, problem: (message: string) => void): TaskConstraint[] {
  const where = `constraints[${index}]`;
  if (!isRecord(item)) {
    problem(`\`${where}\` must be an object`);
    return [];
  }
  for (const key of Object.keys(item)) if (!CONSTRAINT_KEYS.includes(key)) problem(`unknown property \`${where}.${key}\``);
  if (!isStepId(item.id)) problem(`\`${where}.id\` must be lowercase letters, digits, "-" or "_", starting with a letter or digit`);
  if (!isNonBlank(item.statement)) problem(`\`${where}\` needs a non-empty \`statement\`: what the first agent is told`);
  const check = item.check;
  if (!isRecord(check) || !CONSTRAINT_CHECK_KINDS.includes(check.kind as ConstraintCheckKind)) {
    problem(`\`${where}.check.kind\` must be one of ${CONSTRAINT_CHECK_KINDS.join(", ")}: a planted constraint is checked deterministically, never judged`);
    return [];
  }
  const kind = check.kind as ConstraintCheckKind;
  for (const key of Object.keys(check)) if (!CHECK_KEYS[kind].includes(key)) problem(`unknown property \`${where}.check.${key}\` for ${kind}`);
  if (kind === "required_invariant") {
    if (!isNonBlank(check.command)) problem(`\`${where}.check\` needs a non-empty \`command\``);
  } else {
    if (typeof check.pattern !== "string" || check.pattern === "") problem(`\`${where}.check\` needs a non-empty \`pattern\``);
    else {
      const compiled = compilePattern({ pattern: check.pattern, flags: typeof check.flags === "string" ? check.flags : undefined });
      if (typeof compiled === "string") problem(`\`${where}.check\`: ${compiled}`);
      else if (check.flags !== undefined && typeof check.flags !== "string") problem(`\`${where}.check.flags\` must be a string`);
      else if (check.paths !== undefined && !(Array.isArray(check.paths) && check.paths.every(isRepoPath))) problem(`\`${where}.check.paths\` must be an array of repository-relative paths`);
      else {
        // A fixture that already breaks the constraint could not tell a trial that kept it from one that lost it.
        const already = forbiddenPatternViolations(check as Extract<ConstraintCheck, { kind: "forbidden_pattern" }>, fixture);
        if (already.length > 0) problem(`\`${where}\`: the fixture already matches the forbidden pattern in ${already.join(", ")}, so a trial could not violate it`);
      }
    }
  }
  return typeof item.id === "string" && typeof item.statement === "string" ? [{ id: item.id, statement: item.statement, check: check as unknown as ConstraintCheck }] : [];
}

function defectOf(item: unknown, index: number, fixture: ReadonlyMap<string, Buffer>, problem: (message: string) => void): SeededDefect[] {
  const where = `seededDefects[${index}]`;
  if (!isRecord(item)) {
    problem(`\`${where}\` must be an object`);
    return [];
  }
  for (const key of Object.keys(item)) if (!DEFECT_KEYS.includes(key)) problem(`unknown property \`${where}.${key}\``);
  if (!isStepId(item.id)) problem(`\`${where}.id\` must be lowercase letters, digits, "-" or "_", starting with a letter or digit`);
  if (!isNonBlank(item.description)) problem(`\`${where}\` needs a non-empty \`description\``);
  if (typeof item.path !== "string" || !fixture.has(item.path)) problem(`\`${where}.path\` must name a file of the fixture (\`repo/\`)`);
  return typeof item.id === "string" && typeof item.description === "string" && typeof item.path === "string" ? [{ id: item.id, description: item.description, path: item.path }] : [];
}
