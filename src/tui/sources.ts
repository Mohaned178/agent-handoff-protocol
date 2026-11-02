// Where the task flow reads from and writes to, in one place the screens are given: the tools on this machine, the saved
// defaults, the project, the precheck, and the few files the first-open screens write. The defaults are the real thing;
// tests give their own (a PATH of fake tools, a precheck that fails, a slow model list).

import { diagnose, type DoctorReport } from "../doctor/doctor.ts";
import type { Role, RoleAssignment } from "../doctor/init.ts";
import { THIS_REPOSITORY } from "../protocol/index.ts";
import { branchesOf, remotesOf, uncommittedIn } from "../commands/task.ts";
import { locateRepo, settingsPath } from "../runtime/paths.ts";
import { castRoles, inferCommands, type ProjectCommands, type RoleDefault, type RoleDefaults } from "../setup/infer.ts";
import { modelsFor, type ModelList } from "../setup/models.ts";
import { precheck, type Precheck } from "../setup/precheck.ts";
import { inspectRepository, prepareRepository, type RepositoryState } from "../setup/repository.ts";
import { clearStepDefault, clearStepDefaults, markFirstOpenDone, markRealAgentsNoticed, readSettings, saveStepDefault, type SettingsRead } from "../setup/settings.ts";
import type { TaskRun } from "../setup/task.ts";
import { saveTaskWorkflow } from "../commands/workflow-file.ts";
import type { ToolId } from "../doctor/tools.ts";

/** What a task needs to know about the project and the machine before it is summarised. */
export interface TaskContext {
  /** The repository's top level. */
  repo: string;
  found: ProjectCommands;
  /** AHP's casting of the three roles, with the saved defaults on top. */
  base: RoleAssignment[];
  report: DoctorReport;
  settings: SettingsRead;
  /** The branch names a new branch must not take. */
  branches: string[];
  /** Files that differ from the last commit: the agents never see them. */
  uncommitted: number;
}

export interface TaskSources {
  /** The saved settings' first-open flag, and what the folder opened in is. */
  boot: () => Promise<{ firstOpenDone: boolean; repository: RepositoryState }>;
  /** What `diagnose` found; read once and kept for 30 s, or read again with `refresh`. */
  tools: (refresh?: boolean) => Promise<DoctorReport>;
  /** AHP's casting of the three roles from the tools found and the saved defaults: needs no repository. */
  cast: () => Promise<{ report: DoctorReport; base: RoleAssignment[]; settings: SettingsRead }>;
  context: (remote: string | null) => Promise<TaskContext>;
  remotes: () => Promise<string[]>;
  models: (tool: ToolId) => Promise<ModelList>;
  precheck: (repo: string, check: string, install: string | null) => Promise<Precheck>;
  /** Marks the first-open screens done, keeping the steps the person changed there. */
  finishFirstOpen: (chosen: RoleDefaults) => Promise<void>;
  saveDefault: (role: Role, chosen: RoleDefault) => Promise<void>;
  /** The saved defaults as the file holds them (a broken entry is left out, and `problem` says so). */
  settings: () => Promise<SettingsRead>;
  /** Forgets one step's saved default, or all of them; the first-open flag stays. */
  clearDefault: (role: Role) => Promise<void>;
  clearDefaults: () => Promise<void>;
  /** Writes the task's workflow to a file in the repository, refusing one that exists; returns its path. */
  saveWorkflow: (name: string, run: TaskRun) => Promise<string>;
  /** Records that the first run with real agents said what they do. */
  noticedRealAgents: () => Promise<void>;
  /** Makes the folder a repository with a commit (`git init`, the first commit); returns the repository. */
  prepareRepository: (state: RepositoryState) => Promise<string>;
  inspectRepository: () => Promise<RepositoryState>;
}

/** How long a reading of the tools is kept: long enough that the summary does not wait for what home has read already. */
export const TOOLS_KEPT_MS = 30_000;

export function taskSources(cwd: string, env: NodeJS.ProcessEnv = process.env): TaskSources {
  let kept: { at: number; report: Promise<DoctorReport> } | null = null;
  const tools = (refresh = false) => {
    if (refresh || kept === null || Date.now() - kept.at > TOOLS_KEPT_MS) kept = { at: Date.now(), report: diagnose({ env }) };
    return kept.report;
  };
  const cast = async () => {
    const [report, settings] = await Promise.all([tools(), readSettings(settingsPath())]);
    return { report, base: castRoles(report, settings.settings.steps), settings };
  };
  return {
    boot: async () => ({ firstOpenDone: (await readSettings(settingsPath())).settings.firstOpenDone === true, repository: await inspectRepository(cwd) }),
    tools,
    cast,
    context: async (remote) => {
      const repo = (await locateRepo(cwd)).repo;
      const [{ report, base, settings }, branches, uncommitted] = await Promise.all([cast(), branchesOf(repo, remote ?? THIS_REPOSITORY), uncommittedIn(repo)]);
      return { repo, found: inferCommands(repo), base, report, settings, branches, uncommitted };
    },
    remotes: async () => remotesOf((await locateRepo(cwd)).repo),
    models: (tool) => modelsFor(tool, env),
    precheck,
    finishFirstOpen: (chosen) => markFirstOpenDone(settingsPath(), chosen),
    saveDefault: (role, chosen) => saveStepDefault(settingsPath(), role, chosen),
    settings: () => readSettings(settingsPath()),
    clearDefault: (role) => clearStepDefault(settingsPath(), role),
    clearDefaults: () => clearStepDefaults(settingsPath()),
    saveWorkflow: async (name, run) => saveTaskWorkflow((await locateRepo(cwd)).repo, name, run),
    noticedRealAgents: () => markRealAgentsNoticed(settingsPath()),
    prepareRepository,
    inspectRepository: () => inspectRepository(cwd),
  };
}
