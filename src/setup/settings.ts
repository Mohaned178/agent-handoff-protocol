// The per-user defaults of `ahp "<task>"` (spec D5): for each step, the tool, model and effort a person chose in the
// summary's menu and said yes to keeping. Names only, never a credential. Read only by `ahp "<task>"`'s casting: an
// evaluation's casting is its suite's, and a workflow file says its own.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ROLES, type Role } from "../doctor/init.ts";
import { TOOL_IDS, TOOLS, type ToolId } from "../doctor/tools.ts";
import type { RoleDefault, RoleDefaults } from "./infer.ts";
import { effortsFor } from "./models.ts";

export interface Settings {
  steps: RoleDefaults;
  /** Set once the first run with real agents has said that they run commands here and their usage counts. */
  realAgentsNoticed?: true;
}

export interface SettingsRead {
  settings: Settings;
  /** Why some or all of the file was left out, or null when all of it was read (or there is no file). */
  problem: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Why a saved step default cannot be used, or null when it can. */
function problemWith(value: unknown): string | null {
  if (!isRecord(value)) return "not an object";
  if (!TOOL_IDS.includes(value.tool as ToolId)) return `its tool must be ${TOOL_IDS.join(", ")}`;
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.trim() === "")) return "its model must be a name";
  if (value.effort !== undefined && !effortsFor(value.tool as ToolId).includes(value.effort as string)) return `its effort is not one of ${nameOf(value.tool as ToolId)}'s`;
  return null;
}

/** The saved defaults at `path`. A missing file is no defaults; a step the file gets wrong is left out, and `problem` says so. */
export async function readSettings(path: string): Promise<SettingsRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { settings: { steps: {} }, problem: null };
    return { settings: { steps: {} }, problem: `${path} cannot be read: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { settings: { steps: {} }, problem: `${path} is not valid JSON` };
  }
  const given = isRecord(parsed) && isRecord(parsed.steps) ? parsed.steps : null;
  if (given === null) return { settings: { steps: {} }, problem: `${path} has no \`steps\` object` };
  const steps: RoleDefaults = {};
  const problems: string[] = [];
  for (const [role, value] of Object.entries(given)) {
    const problem = ROLES.includes(role as Role) ? problemWith(value) : "no such step";
    if (problem !== null) {
      problems.push(`${role}: ${problem}`);
      continue;
    }
    const { tool, model, effort } = value as RoleDefault;
    steps[role as Role] = { tool, ...(model ? { model: model.trim() } : {}), ...(effort ? { effort } : {}) };
  }
  const noticed = isRecord(parsed) && parsed.realAgentsNoticed === true ? { realAgentsNoticed: true as const } : {};
  return { settings: { steps, ...noticed }, problem: problems.length > 0 ? `${path}: ${problems.join("; ")}` : null };
}

/** Writes `settings` whole to a temporary name, then moves it into place, so a reader never sees half a file. */
async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(temporary, path);
}

/** Keeps `chosen` as `role`'s default, beside the others already saved. */
export async function saveStepDefault(path: string, role: Role, chosen: RoleDefault): Promise<void> {
  const { settings } = await readSettings(path);
  settings.steps[role] = chosen;
  await writeSettings(path, settings);
}

/** Records that the first run with real agents said what they do here, so it is said once. */
export async function markRealAgentsNoticed(path: string): Promise<void> {
  const { settings } = await readSettings(path);
  await writeSettings(path, { ...settings, realAgentsNoticed: true });
}

/** Removes the saved defaults; false when there were none. */
export async function clearSettings(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

const nameOf = (tool: ToolId) => TOOLS.find((definition) => definition.id === tool)!.name;

/** A saved default in words: "Claude Code, model opus, effort high". */
export function describeDefault(chosen: RoleDefault): string {
  return [nameOf(chosen.tool), ...(chosen.model ? [`model ${chosen.model}`] : []), ...(chosen.effort ? [`effort ${chosen.effort}`] : [])].join(", ");
}

/** What `ahp settings` prints: the file's path and each saved default, or that there are none. */
export function formatSettings(path: string, read: SettingsRead): string {
  const rows = ROLES.flatMap((role) => {
    const chosen = read.settings.steps[role];
    return chosen ? [`  ${role.padEnd(10)} ${describeDefault(chosen)}`] : [];
  });
  return [
    rows.length > 0 ? `saved defaults for \`ahp "<task>"\` (${path}):` : `no saved defaults (${path})`,
    ...rows,
    ...(read.problem ? [`  left out: ${read.problem}`] : []),
    ...(rows.length > 0 ? ["`ahp settings --clear` removes them; a change in the summary's menu, kept for next time, adds one"] : []),
  ].join("\n");
}
