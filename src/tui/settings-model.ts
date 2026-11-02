// What `/settings` shows, as data: each step's saved default (the tool, model and effort the person chose and kept), or
// "automatic" when none is saved. "Automatic" is never replaced by what AHP would cast today: that is recomputed from the
// tools found, and is not a default of the person's.

import { ROLES, type Role } from "../doctor/init.ts";
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

export function settingsModel(read: SettingsRead): SettingsModel {
  return {
    rows: ROLES.map((role) => {
      const saved = read.settings.steps[role] ?? null;
      return { role, saved, text: saved ? describeDefault(saved) : AUTOMATIC };
    }),
    problem: read.problem,
  };
}
