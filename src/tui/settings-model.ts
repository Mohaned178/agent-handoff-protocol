// What `/settings` shows, as data: each step's saved default (the tool, model and effort the person chose and kept), or
// "automatic" when none is saved. "Automatic" is never replaced by what AHP would cast today: that is recomputed from the
// tools found, and is not a default of the person's; it is said beside it, "automatic (Codex CLI now)" (ticket 10).

import { ROLES, type Role, type RoleAssignment } from "../doctor/init.ts";
import { TOOLS } from "../doctor/tools.ts";
import { describeDefault, type SettingsRead } from "../setup/settings.ts";
import type { RoleDefault } from "../setup/infer.ts";

export interface SettingsRow {
  role: Role;
  /** The saved default, or null for "automatic". */
  saved: RoleDefault | null;
  /** "Claude Code, model opus, effort high", or "automatic". */
  text: string;
}

export interface SettingsModel {
  rows: SettingsRow[];
  /** Why part or all of the file was left out, or null: shown, and the entry stays out until it is changed or cleared. */
  problem: string | null;
}

export const AUTOMATIC = "automatic";

/** What "automatic" casts a step to today, e.g. "automatic (Codex CLI now)"; plain "automatic" before the tools are read. */
function automaticText(role: Role, cast: readonly RoleAssignment[] | null): string {
  const now = cast?.find((assignment) => assignment.role === role);
  if (!now) return AUTOMATIC;
  const who = now.tool === null ? "the scripted mock" : (TOOLS.find((tool) => tool.id === now.tool)?.name ?? now.adapter);
  return `${AUTOMATIC} (${who} now)`;
}

/** `cast`: AHP's casting from the tools found, without the person's defaults; null while they are read. */
export function settingsModel(read: SettingsRead, cast: readonly RoleAssignment[] | null = null): SettingsModel {
  return {
    rows: ROLES.map((role) => {
      const saved = read.settings.steps[role] ?? null;
      return { role, saved, text: saved ? describeDefault(saved) : automaticText(role, cast) };
    }),
    problem: read.problem,
  };
}
