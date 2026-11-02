// The plain commands' one parser and one usage text. Every command has an entry in `COMMAND_SPECS`: its options, how many
// positional arguments it takes, and its usage line. An option the command does not have is refused with that command's
// usage line, not with a list of every option there is.

import { parseArgs, type ParseArgsConfig } from "node:util";
import { DEFAULT_REMOTE, isRemoteName, THIS_REPOSITORY } from "../protocol/index.ts";
import { ROLES, TOOL_IDS, type Role, type ToolId } from "../doctor/index.ts";
import { isSeed } from "../evaluation/index.ts";

/**
 * A problem with how ahp was invoked; exits 2. The whole usage is printed only when the command itself is missing or
 * unknown: after any other mistake the command's own usage line is.
 */
export class UsageError extends Error {
  readonly showUsage: boolean;
  constructor(message: string, { showUsage = false } = {}) {
    super(message);
    this.showUsage = showUsage;
  }
}

type Options = NonNullable<ParseArgsConfig["options"]>;

const repo = { repo: { type: "string" } } as const satisfies Options;
const json = { json: { type: "boolean" } } as const satisfies Options;

/** What `ahp "<task>"` takes: the step flags are one tool, model and effort per step. */
const stepOptions = Object.fromEntries(
  ROLES.flatMap((role) => [
    [role, { type: "string" }],
    [`${role}-model`, { type: "string" }],
    [`${role}-effort`, { type: "string" }],
  ]),
) as Options;

export interface CommandSpec {
  /** The word that names it; `"<task>"` for the task form. */
  name: string;
  /** Its arguments as the usage line writes them. */
  args: string;
  /** Its options as the usage line writes them. */
  flags: string;
  /** One or two lines: what it does. */
  summary: string;
  options: Options;
  /** How many positional arguments follow the command word. */
  positionals: { min: number; max: number };
}

export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: "<task>",
    args: "",
    flags: "--yes [--plan [<tool>]] [--<step> <tool>] [--<step>-model <name>] [--<step>-effort <level>] [--check <command> | --no-check] [--push [<remote>]] [--save <file>] [--mock] [--no-precheck] [--repo <dir>]",
    summary: "Do a task in words (in quotes): implement → review → your approval, with the check, the install and who plays each step worked out from the project and your tools. Nothing runs without --yes",
    options: {
      ...repo,
      ...stepOptions,
      yes: { type: "boolean", short: "y" },
      plan: { type: "string" },
      push: { type: "string" },
      check: { type: "string" },
      "no-check": { type: "boolean" },
      save: { type: "string" },
      mock: { type: "boolean" },
      "no-precheck": { type: "boolean" },
    },
    positionals: { min: 0, max: 0 },
  },
  { name: "run", args: "<workflow-file>", flags: "[--repo <dir>]", summary: "Run the workflow exported by default from <workflow-file>", options: repo, positionals: { min: 1, max: 1 } },
  {
    name: "approve",
    args: "<run-id> [<gate>]",
    flags: "[--repo <dir>]",
    summary: "Approve the gate a run waits at (name it when more than one waits), then resume the run",
    options: repo,
    positionals: { min: 1, max: 2 },
  },
  {
    name: "reject",
    args: "<run-id> [<gate>]",
    flags: "--reason <text> [--repo <dir>]",
    summary: "Reject it: the step before the gate is sent back with your reason",
    options: { ...repo, reason: { type: "string" } },
    positionals: { min: 1, max: 2 },
  },
  {
    name: "recover",
    args: "<run-id|attempt-id>",
    flags: "[--policy adopt|abort] [--repo <dir>]",
    summary: "Resume a run whose process stopped; with an attempt ID, decide an attempt that awaits recovery: adopt verifies its workspace as its result, abort ends its step",
    options: { ...repo, policy: { type: "string" } },
    positionals: { min: 1, max: 1 },
  },
  { name: "runs", args: "", flags: "[--all] [--json] [--repo <dir>]", summary: "List this repository's runs, newest first, with what to do next for any that waits", options: { ...repo, ...json, all: { type: "boolean" } }, positionals: { min: 0, max: 0 } },
  { name: "inspect", args: "[<run-id>]", flags: "[--json] [--repo <dir>]", summary: "Show a run in full, derived from its ledger, and who is writing it (default: the newest run)", options: { ...repo, ...json }, positionals: { min: 0, max: 1 } },
  { name: "doctor", args: "", flags: "[--json]", summary: "Report this machine and which coding agent tools AHP can use", options: json, positionals: { min: 0, max: 0 } },
  { name: "clean", args: "", flags: "[--dry-run] [--repo <dir>]", summary: "Remove the worktrees of runs that have ended; never one a run waiting for a person may need", options: { ...repo, "dry-run": { type: "boolean" } }, positionals: { min: 0, max: 0 } },
  { name: "demo", args: "", flags: "[--real --yes]", summary: "Try AHP in a sample project it makes: scripted agents, free; --real casts your own tools (their usage counts)", options: { real: { type: "boolean" }, yes: { type: "boolean", short: "y" } }, positionals: { min: 0, max: 0 } },
  {
    name: "eval",
    args: "<suite-file>",
    flags: "[--out <dir>] [--seed <n>] [--json]",
    summary: "Run the evaluation suite exported by default from <suite-file>: tasks frozen, conditions compared, each trial scored by independent validators",
    options: { ...json, out: { type: "string" }, seed: { type: "string" } },
    positionals: { min: 1, max: 1 },
  },
  {
    name: "bench",
    args: "<bench-file>",
    flags: "[--engine <id>] [--out <dir>] [--seed <n>] [--json]",
    summary: "Measure the local inference engines the bench file lists: latency, throughput, quality and tool calls",
    options: { ...json, out: { type: "string" }, seed: { type: "string" }, engine: { type: "string" }, eval: { type: "string", multiple: true } },
    positionals: { min: 0, max: Infinity },
  },
  { name: "help", args: "", flags: "", summary: "Print this text, as --help does", options: {}, positionals: { min: 0, max: 0 } },
];

/** `bench report`, which `bench` hands its arguments to. */
export const BENCH_REPORT_USAGE = "ahp bench report <bench-dir>... [--eval <eval-dir>]... [--out <dir>] [--seed <n>] [--json]";

const specOf = (name: string) => COMMAND_SPECS.find((spec) => spec.name === name);

/** Every command word, for telling a task from a command. */
export const COMMANDS: readonly string[] = COMMAND_SPECS.filter((spec) => spec.name !== "<task>").map((spec) => spec.name);

/** Commands of the old terminal layer that the app replaced: they answer with where they went. */
export const MOVED_COMMANDS: readonly string[] = ["setup", "settings", "init"];

/** The usage line of one command. */
export function usageLineOf(spec: CommandSpec): string {
  return `ahp ${spec.name === "<task>" ? '"<task>"' : spec.name}${spec.args ? ` ${spec.args}` : ""}${spec.flags ? ` ${spec.flags}` : ""}`;
}

const wrap = (text: string, indent: number, width = 100) => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && indent + line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  return [...lines, line];
};

/** The one usage text: `ahp --help` and `ahp help` print it; an unknown command prints it after the error. */
export const USAGE = [
  "Usage: ahp                 open the app (in a terminal)",
  '       ahp "<task>" --yes   do a task without the app',
  "       ahp <command> [options]",
  "",
  "Commands (each takes its own options; `ahp <command> --help` is this text):",
  ...COMMAND_SPECS.filter((spec) => spec.name !== "help" && spec.name !== "<task>").flatMap((spec) => {
    const head = `  ${spec.name}${spec.args ? ` ${spec.args}` : ""}`;
    return [head, ...wrap(spec.summary, 6).map((line) => `      ${line}`)];
  }),
  `  bench report <bench-dir>... [--eval <eval-dir>]...`,
  "      Combine the benches of several engines into one report; refuses benches made on another machine, or with other prompts or settings. --eval puts each engine's verified success beside its speed",
  "",
  "Options of a task:",
  "  --check <command>    the command that checks the work, instead of the one AHP finds",
  "  --no-check           no check: a reviewing agent reads the work, labelled not verified",
  "  --plan [<tool>]      add a read-only plan step first, by <tool> if named",
  "  --implement <tool>, --review <tool>   who does the step: claude-code, codex or opencode (this run only)",
  "  --<step>-model <name>, --<step>-effort <level>   the step's model and effort (plan, implement or review)",
  "  --push [<remote>]    push the approved branch to origin, or <remote>, instead of a local branch",
  "  --save <file>        also write the workflow to <file>, for `ahp run` to run again",
  "  --mock               scripted agents that show the flow and do none of the work (no evidence)",
  "  --no-precheck        start the agents without first running the check once on your last commit",
  "  -y, --yes            run without asking (a task, and demo --real, start agents: they need it)",
  "",
  "Other options:",
  "  --repo <dir>         the git repository to use (default: the current directory)",
  "  --json               inspect, runs, doctor, eval, bench: print data instead of text",
  "  --all                runs: every run, not only the newest 20",
  "  --reason <text>      reject: why the work is rejected (required)",
  "  --policy <decision>  recover: adopt or abort",
  "  --dry-run            clean: say what would go, remove nothing",
  "  --out <dir>          eval, bench: where it is kept; bench report: where to write report.json and report.txt",
  "  --seed <n>           eval, bench: the seed of the order (default: drawn); bench report: of the comparisons (default: 0)",
  "  --engine <id>        bench: run only this engine: ollama, vllm, sglang or tensorrt_llm",
  "  -h, --help, -v, --version",
  "",
  "A run prints one line per step that ends, its receipt, and the one command to run next. Ctrl+C during run, recover,",
  "approve or reject cancels the run: the running agent and every process it started are stopped, and the run ends",
  "cancelled. Ctrl+C during eval or bench cancels the trial or workload in hand and starts no other.",
  "",
  "Exit codes: 0 the run succeeded (eval: it completed, whatever its trials found), 1 it failed or ahp failed (bench: it",
  "stopped on an error, or measured nothing), 2 usage error, 3 the run stopped for a recovery decision, 4 the run stopped",
  "at an approval gate, 130 the run was cancelled",
].join("\n");

/** Whether the first argument is a task rather than a command: not a command, and more than one word. */
export const isTask = (argument: string) => !COMMANDS.includes(argument) && !MOVED_COMMANDS.includes(argument) && argument.trim().split(/\s+/).length > 1;

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

export function stepFlagsOf(values: Record<string, string | string[] | boolean | undefined>): StepFlags {
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

export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

export type Invocation =
  | { kind: "usage" }
  | { kind: "version" }
  | { kind: "moved"; command: string }
  | { kind: "task"; task: string; values: Values; spec: CommandSpec }
  | { kind: "command"; command: string; positionals: string[]; values: Values; spec: CommandSpec };

/** Every option any command has, only to find the command word: an option that takes a value must not leave it behind as one. */
const everyOption: Options = Object.assign({}, ...COMMAND_SPECS.map((spec) => spec.options), { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } });

/** Reads `argv` as one command's invocation, or throws a `UsageError` that names the command's usage line. */
export function parseInvocation(argv: readonly string[]): Invocation {
  const args = withOptionalValues(argv);
  const found = parseArgs({ args, options: everyOption, allowPositionals: true, strict: false });
  const [first, ...rest] = found.positionals as string[];
  if (found.values.help === true) return { kind: "usage" };
  if (found.values.version === true) return { kind: "version" };
  if (first === undefined) return { kind: "usage" };
  if (MOVED_COMMANDS.includes(first)) return { kind: "moved", command: first };
  const task = isTask(first);
  if (!task && !COMMANDS.includes(first)) {
    // Words given unquoted arrive one by one: the first is not a command, and must never be read as a task's start.
    throw new UsageError(rest.length > 0 ? `unknown command: ${first} (a task is one argument, in quotes: ahp "${[first, ...rest].join(" ")}")` : `unknown command: ${first}`, { showUsage: true });
  }
  const spec = task ? specOf("<task>")! : specOf(first)!;
  try {
    // `bench report` has its own positionals and no `--engine`; the command word itself is a positional here.
    const parsed = parseArgs({ args, options: spec.options, allowPositionals: true, strict: true });
    const positionals = parsed.positionals as string[];
    if (task) {
      if (positionals.length > 1) throw usage(spec, `unexpected argument: ${positionals[1]} (a task is one argument, in quotes)`);
      return { kind: "task", task: positionals[0]!.trim(), values: parsed.values as Values, spec };
    }
    const arguments_ = positionals.slice(1);
    if (arguments_.length < spec.positionals.min) throw usage(spec, missingArgument(spec));
    if (arguments_.length > spec.positionals.max) throw usage(spec, `unexpected argument: ${arguments_[spec.positionals.max]}`);
    return { kind: "command", command: spec.name, positionals: arguments_, values: parsed.values as Values, spec };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if ((error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) throw usage(spec, (error as Error).message.split(". To specify")[0]!.replace(/^Unknown option/, "unknown option"));
    throw error;
  }
}

const usage = (spec: CommandSpec, message: string) => new UsageError(`${message}\nusage: ${usageLineOf(spec)}`);

function missingArgument(spec: CommandSpec): string {
  switch (spec.name) {
    case "run":
      return "run needs a workflow file";
    case "eval":
      return "eval needs a suite file";
    case "recover":
      return "recover needs a run ID, or an attempt ID and --policy";
    case "approve":
    case "reject":
      return `${spec.name} needs a run ID`;
    default:
      return `${spec.name} needs ${spec.args.replace(/[<>[\]]/g, "")}`;
  }
}

export { usage as usageOf };
