import { DEFAULT_REMOTE, isRemoteName, THIS_REPOSITORY } from "../protocol/index.ts";
import { ROLES, TOOL_IDS, type Role, type ToolId } from "../doctor/index.ts";
import { isSeed } from "../evaluation/index.ts";

/**
 * A problem with how ahp was invoked; exits 2. The whole usage is printed only when the command itself is missing or
 * unknown: after any other mistake it would bury the one line that says what is wrong.
 */
export class UsageError extends Error {
  readonly showUsage: boolean;
  constructor(message: string, { showUsage = false } = {}) {
    super(message);
    this.showUsage = showUsage;
  }
}

export const COMMANDS = ["doctor", "init", "setup", "demo", "run", "eval", "runs", "inspect", "recover", "approve", "reject", "settings", "help"];

/**
 * Whether the first argument is a task rather than a command (spec D1): not a command, and more than one word. A single
 * word that is not a command stays an unknown command, so a misspelt one never starts agents.
 */
export const isTask = (argument: string) => !COMMANDS.includes(argument) && argument.trim().split(/\s+/).length > 1;

/**
 * The two options whose value may be left out, which `parseArgs` cannot express, written with their value: `--push`
 * alone means origin and `--push <remote>` that remote; `--plan` alone adds the plan step and `--plan <tool>` casts it
 * too. What follows is the value only when it could be one: a task has spaces in it.
 */
export function withOptionalValues(argv: readonly string[]): string[] {
  return argv.map((arg, index) => {
    const next = argv[index + 1];
    const value = next !== undefined && !next.startsWith("-") && !/\s/.test(next) ? next : null;
    if (arg === "--push") return value !== null && isRemoteName(value) && value !== THIS_REPOSITORY ? arg : `--push=${DEFAULT_REMOTE}`;
    if (arg === "--plan") return value !== null ? arg : "--plan=";
    return arg;
  });
}

/** `--<step>`, `--<step>-model` and `--<step>-effort`: a step's tool, model and effort for one run, never saved. */
export type StepFlags = Partial<Record<Role, { tool?: string; model?: string; effort?: string }>>;

export function stepFlagsOf(values: Record<string, string | boolean | undefined>): StepFlags {
  const flags: StepFlags = {};
  for (const role of ROLES) {
    const tool = role === "plan" ? values.plan || undefined : values[role];
    const [model, effort] = [values[`${role}-model`], values[`${role}-effort`]];
    if (tool === undefined && model === undefined && effort === undefined) continue;
    flags[role] = { ...(typeof tool === "string" ? { tool } : {}), ...(typeof model === "string" ? { model } : {}), ...(typeof effort === "string" ? { effort } : {}) };
  }
  return flags;
}

/** Refuses step flags that are wrong whatever is installed, before anything runs; whether a tool is usable is checked later. */
export function checkStepFlags(flags: StepFlags, mock: boolean): void {
  const given = Object.keys(flags);
  if (mock && given.length > 0) throw new UsageError(`--mock casts every step: leave out --mock, or the flags for ${given.join(", ")}`);
  for (const [role, change] of Object.entries(flags)) {
    if (change.tool !== undefined && !TOOL_IDS.includes(change.tool as ToolId)) {
      throw new UsageError(`--${role} must name ${TOOL_IDS.slice(0, -1).join(", ")} or ${TOOL_IDS.at(-1)}, not ${change.tool}`);
    }
    if (change.model !== undefined && change.model.trim() === "") throw new UsageError(`--${role}-model needs a model's name`);
  }
}

/** The `--seed` given, as a number: decimal digits naming an unsigned 32-bit integer. */
export function seedOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seed = /^\d{1,10}$/.test(value) ? Number(value) : Number.NaN;
  if (!isSeed(seed)) throw new UsageError(`--seed must be an integer from 0 to 4294967295, not ${value}`);
  return seed;
}
