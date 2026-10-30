import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { MockAttemptScript } from "../adapters/index.ts";
import { DEFAULT_REMOTE, THIS_REPOSITORY } from "../protocol/index.ts";
import { git } from "../runtime/git.ts";
import { validateWorkflow } from "../sdk/workflow.ts";
import { diagnose, type DoctorOptions, type DoctorReport } from "./doctor.ts";
import { TOOLS, type ToolId } from "./tools.ts";

export const DEFAULT_WORKFLOW_FILE = "ahp.workflow.mjs";
export const DEFAULT_BRANCH = "ahp/password-reset";

/** The three roles of the reference scenario that a coding agent plays. */
export const ROLES = ["plan", "implement", "review"] as const;
export type Role = (typeof ROLES)[number];

/** Who plays each role when everything is installed: the reference scenario's casting. */
export const PREFERRED: Record<Role, ToolId> = { plan: "claude-code", implement: "codex", review: "opencode" };

export interface RoleAssignment {
  role: Role;
  /** The adapter the step names: a tool's, or `mock`. */
  adapter: string;
  /** The tool behind it, or null for the mock. */
  tool: ToolId | null;
  /** Why this adapter, in a sentence. */
  reason: string;
  /** The model the step requests; absent for the tool's own default. */
  model?: string;
  /** The adapter's `effort` option; absent for the tool's own default. */
  effort?: string;
}

/**
 * Casts the roles from the tools doctor found usable: a role goes to its preferred tool when that is usable, else to
 * the first usable tool in the order of `TOOLS`, else to the mock adapter. Pure, so the casting can be tested as a table.
 */
export function assignRoles(usable: readonly ToolId[]): RoleAssignment[] {
  const nameOf = (id: ToolId) => TOOLS.find((tool) => tool.id === id)!.name;
  return ROLES.map((role): RoleAssignment => {
    const preferred = PREFERRED[role];
    if (usable.includes(preferred)) return { role, adapter: preferred, tool: preferred, reason: `${nameOf(preferred)} is installed and has an adapter` };
    const other = TOOLS.find((tool) => usable.includes(tool.id));
    if (other) return { role, adapter: other.id, tool: other.id, reason: `${nameOf(preferred)} is not usable here; ${other.name} is` };
    return { role, adapter: "mock", tool: null, reason: "no installed tool has an adapter in this build, so the scripted mock adapter stands in" };
  });
}

const MODULE = "src/password-reset.mjs";
const HIDDEN_TEST = "test/password-reset.hidden.mjs";

/** What the implementing step is told: the hidden test cannot be seen, so the interface it imports must be in here. */
const IMPLEMENT_INSTRUCTIONS = `Implement the core of a password-reset endpoint in ${MODULE} (plain ES module, no dependencies).
It exports two functions over an in-memory user store, a Map from email to { password, resetToken?, resetExpires? }:
  requestReset(users, email, now = Date.now())
    Returns a new random reset token (a string of at least 16 characters) for a known email and stores it on the
    user with an expiry one hour after \`now\`. Returns null for an unknown email and changes nothing.
  resetPassword(users, token, newPassword, now = Date.now())
    Returns true and sets the new password when \`token\` is a user's current, unexpired token and \`newPassword\` is
    at least 8 characters; the token then no longer works. Returns false, changing nothing, in every other case.`;

const IMPLEMENTATION = (note: string) => `import { randomBytes } from "node:crypto";

const ONE_HOUR = 60 * 60 * 1000;
${note}
export function requestReset(users, email, now = Date.now()) {
  const user = users.get(email);
  if (!user) return null;
  user.resetToken = randomBytes(16).toString("hex");
  user.resetExpires = now + ONE_HOUR;
  return user.resetToken;
}

export function resetPassword(users, token, newPassword, now = Date.now()) {
  if (typeof token !== "string" || typeof newPassword !== "string" || newPassword.length < 8) return false;
  for (const user of users.values()) {
    if (user.resetToken === token && now <= user.resetExpires) {
      user.password = newPassword;
      delete user.resetToken;
      delete user.resetExpires;
      return true;
    }
  }
  return false;
}
`;

/** The check the verification step adds after the agent is done: the agent never sees this file. */
const HIDDEN_TEST_CONTENT = `import assert from "node:assert/strict";
import { requestReset, resetPassword } from "../${MODULE}";

const HOUR = 60 * 60 * 1000;
const users = new Map([["ada@example.com", { password: "old-password" }]]);

assert.equal(requestReset(users, "nobody@example.com", 0), null, "an unknown email gets no token");
const token = requestReset(users, "ada@example.com", 0);
assert.equal(typeof token, "string");
assert.ok(token.length >= 16, "the token is long enough to be unguessable");

assert.equal(resetPassword(users, "wrong-token", "new-password", 1000), false, "a wrong token does nothing");
assert.equal(users.get("ada@example.com").password, "old-password");
assert.equal(resetPassword(users, token, "short", 1000), false, "a short password is refused");
assert.equal(resetPassword(users, token, "new-password", HOUR + 1), false, "an expired token does nothing");

assert.equal(resetPassword(users, token, "new-password", HOUR), true, "the token works until it expires");
assert.equal(users.get("ada@example.com").password, "new-password");
assert.equal(resetPassword(users, token, "another-password", HOUR), false, "a token works once");
console.log("password reset: ok");
`;

/** The scripts the mock plays, one per attempt: plan once, implement twice (the review sends it back once), review twice. */
const MOCK_SCRIPTS: Record<Role, MockAttemptScript[]> = {
  plan: [
    {
      outputFields: {
        summary: "Two pure functions over a user store: requestReset issues a one-hour token, resetPassword consumes it once.",
        decisions: ["no HTTP layer in the core logic", "tokens are random hex and single use", "passwords need at least 8 characters"],
      },
    },
  ],
  implement: [
    { edits: [{ path: MODULE, content: IMPLEMENTATION("") }], outputFields: { summary: "requestReset and resetPassword, with one-hour single-use tokens." } },
    {
      edits: [{ path: MODULE, content: IMPLEMENTATION("// A token works once: resetPassword removes it from the user when it is used.\n") }],
      outputFields: { summary: "Documented that a token is single use, as the review asked." },
    },
  ],
  review: [
    { outputFields: { verdict: "changes_requested", findings: ["Say in a comment that a token is single use."] } },
    { outputFields: { verdict: "approved", findings: "Nothing more to change." } },
  ],
};

function agentOf({ role, adapter, model, effort }: RoleAssignment) {
  if (adapter === "mock") return { adapter, options: { attempts: MOCK_SCRIPTS[role] } };
  return { adapter, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { options: { effort } }) };
}

/** The last step: push the approved commit; `remote` is left out when it is the default. */
const publishAction = (branch: string, remote: string) => ({ kind: "push_branch", branch, ...(remote === DEFAULT_REMOTE ? {} : { remote }) });

/**
 * Where a generated workflow publishes in the repository around `dir`: `origin` when it has a remote of that name, else
 * the repository itself (`.`), so a project with no remote still gets the approved work, on a local branch, rather than
 * a run that fails at its last step.
 */
export async function publishRemoteOf(dir: string): Promise<string> {
  try {
    await git(dir, ["remote", "get-url", DEFAULT_REMOTE]);
    return DEFAULT_REMOTE;
  } catch {
    return THIS_REPOSITORY;
  }
}

/** The reference scenario as a workflow definition: plan, implement, review (with send-back), approval gate, push. */
export function buildWorkflow(assignments: readonly RoleAssignment[], branch = DEFAULT_BRANCH, remote = DEFAULT_REMOTE): Record<string, unknown> {
  const who = (role: Role) => assignments.find((assignment) => assignment.role === role)!;
  return {
    name: "password-reset",
    steps: [
      {
        id: "plan",
        agent: agentOf(who("plan")),
        instructions: "Plan a small password-reset endpoint: request a reset token by email, then reset the password with it. Write no code; report a summary and the decisions you made.",
        verification: { requiredOutputFields: ["summary", "decisions"] },
        capabilities: [{ kind: "read_only" }],
      },
      {
        id: "implement",
        agent: agentOf(who("implement")),
        instructions: IMPLEMENT_INSTRUCTIONS,
        verification: {
          command: `node ${HIDDEN_TEST}`,
          requiredOutputFields: ["summary"],
          hiddenTests: [{ path: HIDDEN_TEST, content: HIDDEN_TEST_CONTENT }],
        },
        capabilities: [{ kind: "write_scope", paths: ["src", "test"] }],
      },
      {
        id: "review",
        agent: agentOf(who("review")),
        instructions: `Review ${MODULE} against the plan. Report a verdict of approved or changes_requested, and your findings.`,
        review: { sendBackTo: "implement" },
        verification: {},
        capabilities: [{ kind: "read_only" }],
      },
      { id: "approve", approval: {} },
      { id: "publish", action: publishAction(branch, remote) },
    ],
  };
}

/**
 * A task of the user's own, as `ahp setup` asks for it: what to build, the command that says it is done, and where the
 * implementing agent may write. Nothing about it is hidden from the agents: the check is the user's own.
 */
export interface UserTask {
  /** The workflow's name, short. */
  name: string;
  /** What the agents are to build or change, in the user's words. */
  goal: string;
  /** Run in a fresh verification worktree; exit 0 means the implement step is done. */
  command: string;
  /** Run before `command` in that worktree (dependencies are not in a fresh checkout); null for none. */
  install: string | null;
  /** Repository-relative paths the implementing agent may change; empty for anywhere in the repository. */
  paths: string[];
}

/** A workflow for the user's own task: plan, implement (verified by the user's command), review, gate, push. */
export function buildTaskWorkflow(assignments: readonly RoleAssignment[], task: UserTask, branch: string, remote = DEFAULT_REMOTE): Record<string, unknown> {
  const who = (role: Role) => assignments.find((assignment) => assignment.role === role)!;
  const scope = task.paths.length > 0 ? ` Change only ${task.paths.join(", ")}.` : "";
  return {
    name: task.name,
    steps: [
      {
        id: "plan",
        agent: agentOf(who("plan")),
        instructions: `Plan this task:\n${task.goal}\n\nRead the repository first. Write no code; report a summary and the decisions you made.`,
        verification: { requiredOutputFields: ["summary", "decisions"] },
        capabilities: [{ kind: "read_only" }],
      },
      {
        id: "implement",
        agent: agentOf(who("implement")),
        instructions: `${task.goal}\n\nThe work is done when \`${task.command}\` passes.${scope}`,
        verification: { command: task.command, ...(task.install ? { install: task.install } : {}), requiredOutputFields: ["summary"] },
        ...(task.paths.length > 0 ? { capabilities: [{ kind: "write_scope", paths: task.paths }] } : {}),
      },
      {
        id: "review",
        agent: agentOf(who("review")),
        instructions: `Review the change made for this task against the plan:\n${task.goal}\n\nReport a verdict of approved or changes_requested, and your findings.`,
        review: { sendBackTo: "implement" },
        verification: {},
        capabilities: [{ kind: "read_only" }],
      },
      { id: "approve", approval: {} },
      { id: "publish", action: publishAction(branch, remote) },
    ],
  };
}

/** The text of a workflow file for `assignments`; its header says which steps are scripted by the mock. */
export function renderWorkflow(assignments: readonly RoleAssignment[], branch = DEFAULT_BRANCH, writtenBy = "init", remote = DEFAULT_REMOTE): string {
  return renderFile(buildWorkflow(assignments, branch, remote), assignments, branch, remote, writtenBy, [
    "// The password-reset reference scenario: plan, implement (verified by a hidden test), review (a request for",
    "// changes sends implement back), an approval gate, then AHP itself pushes the approved commit.",
  ]);
}

/** The text of a workflow file for the user's own task. */
export function renderTaskWorkflow(assignments: readonly RoleAssignment[], task: UserTask, branch: string, writtenBy = "setup", remote = DEFAULT_REMOTE): string {
  return renderFile(buildTaskWorkflow(assignments, task, branch, remote), assignments, branch, remote, writtenBy, [
    `// ${task.name}: plan, implement (done when \`${task.command}\` passes), review (a request for changes sends`,
    "// implement back), an approval gate, then AHP itself pushes the approved commit.",
  ]);
}

function renderFile(workflow: Record<string, unknown>, assignments: readonly RoleAssignment[], branch: string, remote: string, writtenBy: string, about: string[]): string {
  const problems = validateWorkflow(workflow);
  if (problems.length > 0) throw new Error(`the generated workflow is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  const cast = assignments.map(({ role, adapter, tool, model, effort }) => `//   ${role.padEnd(9)} ${adapter}${model ? `, model ${model}` : ""}${effort ? `, effort ${effort}` : ""}${tool === null ? "  (scripted mock: not a real coding agent, and its output is no evidence)" : ""}`);
  return [
    ...about,
    "//",
    `// Written by \`ahp ${writtenBy}\`. Who plays each step:`,
    ...cast,
    "//",
    ...(remote === THIS_REPOSITORY
      ? [
          "// Run it in a git repository with a commit: `ahp run " + DEFAULT_WORKFLOW_FILE + "`. It stops at the gate for your approval;",
          "// then AHP puts the approved commit on branch " + branch + " in this repository (there was no remote named origin;",
          "// set the publish step's `remote` to push to one instead). `git merge " + branch + "` takes it into your branch.",
        ]
      : [
          "// Run it in a git repository with a commit and a remote named " + remote + ": `ahp run " + DEFAULT_WORKFLOW_FILE + "`.",
          "// It stops at the gate (exit code 4); `ahp approve <run-id> approve` lets AHP push " + branch + ".",
        ]),
    "",
    `export default ${JSON.stringify(workflow, null, 2)};`,
    "",
  ].join("\n");
}

export interface InitOptions extends DoctorOptions {
  /** The directory the file is written in. */
  dir: string;
  /** The file to write, relative to `dir`. Default `ahp.workflow.mjs`. */
  file?: string;
  branch?: string;
  /** Where the workflow publishes; default `publishRemoteOf(dir)`. */
  remote?: string;
  /** A report to use instead of looking at this machine. */
  report?: DoctorReport;
}

export interface InitResult {
  path: string;
  assignments: RoleAssignment[];
  report: DoctorReport;
  /** Where the workflow publishes: a remote, or `.` for a branch in this repository. */
  remote: string;
}

/** `ahp init` refuses to replace a file. */
export class InitRefusedError extends Error {
  override name = "InitRefusedError";
}

/** Looks at this machine as `ahp doctor` does, casts the reference scenario from the tools it found, and writes it. */
export async function initWorkflow(options: InitOptions): Promise<InitResult> {
  const report = options.report ?? (await diagnose(options));
  const assignments = assignRoles(report.tools.filter((tool) => tool.usable).map((tool) => tool.id));
  const remote = options.remote ?? (await publishRemoteOf(options.dir));
  const content = renderWorkflow(assignments, options.branch, "init", remote);
  const path = resolve(options.dir, options.file ?? DEFAULT_WORKFLOW_FILE);
  try {
    // Exclusive: an existing file is never replaced, and none appears between a check and the write.
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new InitRefusedError(`${path} already exists; ahp init does not replace a file`);
    throw error;
  }
  return { path, assignments, report, remote };
}
