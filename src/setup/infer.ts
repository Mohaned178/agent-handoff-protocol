// What `ahp "<task>"` works out instead of asking: how the project is checked and installed, who plays each step, and the
// branch the approved work goes on. Each answer says where it came from, so the summary can show it and a wrong guess is
// seen before anything runs. Only files at the repository's root (and its `tests` directory) are looked at: nothing is
// run, and a symbolic link is not followed, so nothing outside the repository is read.

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DoctorReport } from "../doctor/doctor.ts";
import { assignRoles, type Role, type RoleAssignment } from "../doctor/init.ts";
import { TOOLS, type ToolId } from "../doctor/tools.ts";
import { slugOf } from "./wizard.ts";

/** A command AHP worked out, and the file it worked it out from. */
export interface Inferred {
  command: string;
  /** The repository-relative file (or directory, ending in "/") the command came from. */
  source: string;
}

export interface ProjectCommands {
  /** What verifies the implement step; null when nothing in the project names one (spec D3: it is asked for, never invented). */
  check: Inferred | null;
  /** What installs dependencies in a fresh verification worktree first; null when none is needed or known. */
  install: Inferred | null;
}

/** A role's tool, model and effort as the person chose them for next time (ticket 03 keeps them). */
export interface RoleDefault {
  tool: ToolId;
  model?: string;
  effort?: string;
}
export type RoleDefaults = Partial<Record<Role, RoleDefault>>;

/** The reason of an assignment that is the person's saved default; one whose default was set aside starts with it. */
export const YOUR_DEFAULT = "your default";

/** npm init's `test` script, which only fails: not a check. */
const NPM_PLACEHOLDER = "Error: no test specified";

/** The contents of a regular file at `dir`'s root, or null: absent, a directory, or a symbolic link. */
function fileIn(dir: string, name: string): string | null {
  try {
    if (!lstatSync(join(dir, name)).isFile()) return null;
    return readFileSync(join(dir, name), "utf8");
  } catch {
    return null;
  }
}

function directoryIn(dir: string, name: string): boolean {
  try {
    return lstatSync(join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}

function testScriptOf(packageJson: string): string | null {
  try {
    const test = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts?.test;
    return typeof test === "string" && test.trim() !== "" && !test.includes(NPM_PLACEHOLDER) ? test : null;
  } catch {
    return null;
  }
}

/** Whether a Makefile has a rule for `test`: a line naming it among its targets, before a ":" that is not ":=". */
function hasTestTarget(makefile: string): boolean {
  for (const [, targets] of makefile.matchAll(/^([^\s:#=][^:#=]*?)\s*::?(?!=)/gm)) {
    if (targets!.split(/\s+/).includes("test")) return true;
  }
  return false;
}

function checkOf(dir: string, packageJson: string | null): Inferred | null {
  if (packageJson !== null && testScriptOf(packageJson) !== null) return { command: "npm test", source: "package.json" };
  for (const name of ["pyproject.toml", "pytest.ini"]) {
    if (fileIn(dir, name) !== null) return { command: "pytest", source: name };
  }
  if (directoryIn(dir, "tests")) return { command: "pytest", source: "tests/" };
  if (fileIn(dir, "Cargo.toml") !== null) return { command: "cargo test", source: "Cargo.toml" };
  if (fileIn(dir, "go.mod") !== null) return { command: "go test ./...", source: "go.mod" };
  const makefile = fileIn(dir, "Makefile");
  if (makefile !== null && hasTestTarget(makefile)) return { command: "make test", source: "Makefile" };
  return null;
}

const LOCKFILES = [
  ["package-lock.json", "npm ci"],
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
] as const;

/**
 * A Node project's install, from its lockfile, whatever the check: a `make test` may need `node_modules` as much as
 * `npm test` does. Python, Rust and Go test commands need none.
 */
function installOf(dir: string, packageJson: string | null): Inferred | null {
  if (packageJson === null) return null;
  for (const [lockfile, command] of LOCKFILES) {
    if (fileIn(dir, lockfile) !== null) return { command, source: lockfile };
  }
  return { command: "npm install", source: "package.json" };
}

/** How the project in `dir` is checked and installed, first match wins, each with its source. Reads files, runs nothing. */
export function inferCommands(dir: string): ProjectCommands {
  const packageJson = fileIn(dir, "package.json");
  return { check: checkOf(dir, packageJson), install: installOf(dir, packageJson) };
}

/**
 * Who plays each role: `assignRoles` over the tools doctor found usable, then the person's defaults on top where their
 * tool is usable here. A default whose tool is not is set aside, and the reason says so.
 */
export function castRoles(report: DoctorReport, defaults: RoleDefaults = {}): RoleAssignment[] {
  const usable = report.tools.filter((tool) => tool.usable).map((tool) => tool.id);
  return assignRoles(usable).map((assignment): RoleAssignment => {
    const chosen = defaults[assignment.role];
    if (!chosen) return assignment;
    if (!usable.includes(chosen.tool)) {
      const name = TOOLS.find((tool) => tool.id === chosen.tool)?.name ?? chosen.tool;
      return { ...assignment, reason: `${YOUR_DEFAULT}, ${name}, is not usable here; ${assignment.reason}` };
    }
    const { role } = assignment;
    return { role, adapter: chosen.tool, tool: chosen.tool, reason: YOUR_DEFAULT, ...(chosen.model ? { model: chosen.model } : {}), ...(chosen.effort ? { effort: chosen.effort } : {}) };
  });
}

/** `ahp/` and the task's first words, with a number added while that branch is among `existing`. */
export function branchFor(task: string, existing: readonly string[]): string {
  const base = `ahp/${slugOf(task)}`;
  let branch = base;
  for (let n = 2; existing.includes(branch); n++) branch = `${base}-${n}`;
  return branch;
}

export interface TaskInferenceInput {
  /** The repository's root. */
  dir: string;
  /** The task, in the person's words. */
  task: string;
  /** What `ahp doctor` found on this machine. */
  report: DoctorReport;
  /** The repository's branch names, so the new one is not among them. */
  branches: readonly string[];
  defaults?: RoleDefaults;
}

export interface TaskInference extends ProjectCommands {
  task: string;
  /** One assignment per role in `ROLES`; the caller runs the roles it wants. */
  assignments: RoleAssignment[];
  branch: string;
}

/** Everything `ahp "<task>"` can work out without asking: the questions `ahp setup` asks, answered from the project. */
export function inferTask(input: TaskInferenceInput): TaskInference {
  return {
    task: input.task,
    ...inferCommands(input.dir),
    assignments: castRoles(input.report, input.defaults),
    branch: branchFor(input.task, input.branches),
  };
}
