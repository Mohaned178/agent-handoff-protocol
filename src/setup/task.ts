// `ahp "<task>"`: the workflow a one-sentence task runs, built in memory from what `infer.ts` worked out, and the summary
// shown before it runs. It is an ordinary workflow (no new step kind): implement, verified by the project's check, then
// review with send-back, then the approval gate, then AHP itself puts the approved commit on a branch; `plan` first when
// asked for. Nothing here is written to disk.

import type { MockAttemptScript } from "../adapters/index.ts";
import { type Role, type RoleAssignment } from "../doctor/init.ts";
import { TOOLS } from "../doctor/tools.ts";
import { THIS_REPOSITORY, type AgentRef, type WorkflowDefinition, type WorkflowStepDefinition } from "../protocol/index.ts";
import { YOUR_DEFAULT, type Inferred } from "./infer.ts";
import { slugOf } from "./wizard.ts";

/** Where a check came from when it was not found in a file: `--check`, or typed at the question. */
export const CHECK_FROM_FLAG = "--check";
export const CHECK_TYPED = "typed";

export interface TaskRun {
  /** The task, in the person's words. */
  task: string;
  /** What verifies implement; null for "review only": the work is then not verified (spec D3). */
  check: Inferred | null;
  /** Run before the check in the verification worktree; ignored without a check. */
  install: Inferred | null;
  /** Who plays each step, in the order the steps run: `stepsOf`'s roles. */
  assignments: RoleAssignment[];
  /** The branch the approved commit goes on. */
  branch: string;
  /** Where that branch goes: `.` (this repository, the default) or a remote's name. */
  remote: string;
}

/** The agent steps a task runs (spec D4): implement → review, with plan first when asked for. */
export function stepsOf(plan: boolean): Role[] {
  return plan ? ["plan", "implement", "review"] : ["implement", "review"];
}

/** What the mock plays for a task it knows nothing about: it shows the flow and does none of the work. */
export function mockScripts(task: string): Record<Role, MockAttemptScript[]> {
  return {
    plan: [{ outputFields: { summary: "Scripted plan: the mock does not read the task.", decisions: ["none: the mock decides nothing"] } }],
    implement: [
      {
        edits: [{ path: "AHP-MOCK.md", content: `The scripted mock adapter stood in for a coding agent here. It did not do this task:\n\n${task}\n` }],
        outputFields: { summary: "Scripted: wrote AHP-MOCK.md and nothing else." },
      },
    ],
    review: [{ outputFields: { verdict: "approved", findings: "Scripted: the mock approves without reading." } }],
  };
}

/** Every step played by the mock, for `--mock`. */
export function mockCasting(roles: readonly Role[]): RoleAssignment[] {
  return roles.map((role) => ({ role, adapter: "mock", tool: null, reason: "--mock" }));
}

function agentOf({ role, adapter, model, effort }: RoleAssignment, task: string): AgentRef {
  if (adapter === "mock") return { adapter, options: { attempts: mockScripts(task)[role] } };
  return { adapter, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { options: { effort } }) };
}

/** The workflow a task runs: its agent steps, the approval gate (spec D6), and the push of the approved commit. */
export function buildTaskRun(run: TaskRun): WorkflowDefinition {
  const roles = run.assignments.map((assignment) => assignment.role);
  const planned = roles.includes("plan");
  const steps = run.assignments.map((assignment): WorkflowStepDefinition => {
    const agent = agentOf(assignment, run.task);
    switch (assignment.role) {
      case "plan":
        return {
          id: "plan",
          agent,
          instructions: `Plan this task:\n${run.task}\n\nRead the repository first. Write no code; report a summary and the decisions you made.`,
          verification: { requiredOutputFields: ["summary", "decisions"] },
          capabilities: [{ kind: "read_only" }],
        };
      case "implement":
        return {
          id: "implement",
          agent,
          instructions: run.check
            ? `${run.task}\n\nThe work is done when \`${run.check.command}\` passes.`
            : `${run.task}\n\nNo command checks this work: a review reads it.`,
          verification: run.check
            ? { command: run.check.command, ...(run.install ? { install: run.install.command } : {}), requiredOutputFields: ["summary"] }
            : { requiredOutputFields: ["summary"] },
        };
      case "review":
        return {
          id: "review",
          agent,
          instructions: `Review the change made for this task${planned ? " against the plan" : ""}:\n${run.task}\n\nReport a verdict of approved or changes_requested, and your findings.`,
          review: { sendBackTo: "implement" },
          verification: {},
          capabilities: [{ kind: "read_only" }],
        };
    }
  });
  const action = { kind: "push_branch" as const, branch: run.branch, remote: run.remote };
  return { name: slugOf(run.task), steps: [...steps, { id: "approve", approval: {} }, { id: "publish", action }] };
}

/** The text of `--save`'s workflow file: the same workflow, for `ahp run` to run again. */
export function renderTaskRun(run: TaskRun): string {
  const roles = run.assignments.map((assignment) => assignment.role).join(" → ");
  const check = run.check ? `implement is done when \`${run.check.command}\` passes` : "no command checks the work: it is not verified";
  return [
    `// Saved by \`ahp "<task>" --save\`: ${roles}, an approval gate, then AHP puts the approved commit on branch`,
    `// ${run.branch}${run.remote === THIS_REPOSITORY ? " in this repository" : ` and pushes it to ${run.remote}`}; ${check}.`,
    "// Run it again with `ahp run <this file>`; a branch that exists by then is not overwritten, and the publish step fails.",
    "",
    `export default ${JSON.stringify(buildTaskRun(run), null, 2)};`,
    "",
  ].join("\n");
}

const COLUMN = 26;
const toolName = (assignment: RoleAssignment) => (assignment.tool === null ? "Mock (scripted)" : (TOOLS.find((tool) => tool.id === assignment.tool)?.name ?? assignment.adapter));

function sourceOf(found: Inferred): string {
  if (found.source === CHECK_FROM_FLAG) return "(--check)";
  if (found.source === CHECK_TYPED) return "(you typed it)";
  return `(from ${found.source})`;
}

function castLine(assignment: RoleAssignment): string {
  if (assignment.tool === null) return "no real agent: its output is no evidence";
  const model = assignment.model ?? "its default model";
  // A default set aside says why up to the casting's own reason: "your default, OpenCode, is not usable here".
  const mine = assignment.reason === YOUR_DEFAULT ? "  (your default)" : assignment.reason.startsWith(`${YOUR_DEFAULT}, `) ? `  (${assignment.reason.split(";")[0]})` : "";
  return `${model}${assignment.effort ? `, effort ${assignment.effort}` : ""}${mine}`;
}

/**
 * What `ahp "<task>"` is about to do, every answer with where it came from: shown before anything runs, so a wrong guess
 * is seen. `uncommitted` is how many files differ from the last commit, which the agents never see.
 */
export function formatTaskSummary(run: TaskRun, uncommitted: number): string {
  const row = (label: string, value: string, note = "") => `  ${label.padEnd(10)} ${note ? value.padEnd(COLUMN) : value}${note ? ` ${note}` : ""}`;
  const lines = [row("task", run.task)];
  if (run.check) {
    lines.push(row("check", run.check.command, sourceOf(run.check)));
    lines.push(run.install ? row("install", run.install.command, sourceOf(run.install)) : row("install", "none"));
  } else {
    lines.push(row("check", "none: review only", "(not verified: no check command)"));
  }
  for (const assignment of run.assignments) lines.push(row(assignment.role, toolName(assignment), castLine(assignment)));
  lines.push(
    run.remote === THIS_REPOSITORY
      ? row("result", `local branch ${run.branch}`, "(nothing is pushed)")
      : row("result", `branch ${run.branch}`, `(pushed to ${run.remote} once you approve)`),
  );
  if (uncommitted > 0) {
    lines.push(row("note", `agents work from your last commit; ${uncommitted} changed ${uncommitted === 1 ? "file is" : "files are"} not in it`));
  }
  return lines.join("\n");
}
