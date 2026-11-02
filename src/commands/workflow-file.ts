// "Save as workflow": a task's workflow written to a file the person names, for `ahp run <file>` to run again. The same
// workflow the summary shows (`buildTaskRun`), never replacing a file that is there.

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { THIS_REPOSITORY } from "../protocol/index.ts";
import { buildTaskRun, type TaskRun } from "../setup/task.ts";

/** `ahp run` imports the file as a module; `.mjs` is a module whatever the project's package.json says. */
export const WORKFLOW_EXTENSION = ".mjs";

/** The refusal of a name that cannot be saved, or the name with its extension. */
export function workflowFileName(typed: string): { name: string } | { error: string } {
  const name = typed.trim();
  if (name === "") return { error: "name the file, e.g. password-reset.mjs" };
  const extension = extname(name);
  if (extension === "") return { name: `${name}${WORKFLOW_EXTENSION}` };
  if (extension.toLowerCase() !== WORKFLOW_EXTENSION) return { error: `the file must end in ${WORKFLOW_EXTENSION} (ahp run loads it as a module), not ${extension}` };
  return { name };
}

/** The text of the file: a header that says what the workflow does (and when the mock plays it), then the workflow. */
export function renderWorkflowFile(run: TaskRun): string {
  const roles = run.assignments.map((assignment) => assignment.role).join(" → ");
  const check = run.check ? `implement is done when \`${run.check.command}\` passes` : "no command checks the work: it is not verified";
  const mocked = run.assignments.filter((assignment) => assignment.tool === null).map((assignment) => assignment.role);
  return [
    `// Saved from the ahp app: ${roles}, an approval gate, then AHP puts the approved commit on branch`,
    `// ${run.branch}${run.remote === THIS_REPOSITORY ? " in this repository" : ` and pushes it to ${run.remote}`}; ${check}.`,
    ...(mocked.length > 0 ? [`// The scripted mock plays ${mocked.join(", ")}: it is not a real coding agent, and its output is no evidence.`] : []),
    "// Run it again with `ahp run <this file>`; a branch that exists by then is not overwritten, and the publish step fails.",
    "",
    `export default ${JSON.stringify(buildTaskRun(run), null, 2)};`,
    "",
  ].join("\n");
}

/** Thrown when the file is already there: nothing was written. */
export class WorkflowFileExistsError extends Error {
  override name = "WorkflowFileExistsError";
}

/** Writes the task's workflow to `name` under `dir` and returns the path. Exclusive: a file that exists is never replaced. */
export async function saveTaskWorkflow(dir: string, typed: string, run: TaskRun): Promise<string> {
  const named = workflowFileName(typed);
  if ("error" in named) throw new Error(named.error);
  const path = resolve(dir, named.name);
  const content = renderWorkflowFile(run);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new WorkflowFileExistsError(`${path} already exists; it is not replaced. Name another file.`);
    throw error;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return path;
}
