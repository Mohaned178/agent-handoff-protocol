import { readFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { adapters as registeredAdapters } from "../adapters/index.ts";
import type { Adapter } from "../adapters/index.ts";
import { osLabelOf } from "../conformance/result.ts";
import {
  CAPABILITY_KINDS,
  levelOn,
  NETWORK_STANCES,
  type CapabilityKind,
  type EnforcementLevel,
  type LoginKind,
  type ModelReportingLevel,
  type NetworkStance,
  type TransportKind,
} from "../protocol/index.ts";
import type { Clock } from "../runtime/clock.ts";
import { firstLine, probe, type ProbeResult } from "./probe.ts";
import { TOOLS, type ToolDefinition, type ToolId } from "./tools.ts";

/**
 * The oldest git AHP supports: 2.20 added the per-worktree configuration (`extensions.worktreeConfig`,
 * `git config --worktree`) that `src/runtime/workspace.ts` sets `core.longpaths` through.
 */
export const MINIMUM_GIT = { major: 2, minor: 20 } as const;

export interface DoctorOptions {
  /** The environment PATH is searched in and the tools run with. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default `process.platform`; the levels an adapter declares are read for it. */
  platform?: NodeJS.Platform;
  clock?: Clock;
  /** How long each version or status command is given. */
  timeoutMs?: number;
  /** The adapters that count as present in this build. Default: those a workflow can name. */
  adapters?: ReadonlyMap<string, Adapter>;
  /** Default `process.versions.node`. */
  nodeVersion?: string;
}

export interface SystemReport {
  os: { platform: string; release: string; /** The support-matrix label, or null on a system AHP has none for. */ label: string | null; supported: boolean };
  node: { version: string; required: string; meets: boolean };
  git: { version: string | null; required: string; meets: boolean; detail: string | null };
}

/** What an adapter declares for its tool, on the system doctor ran on: declared levels, not anything observed. */
export interface AdapterReport {
  name: string;
  transport: TransportKind;
  modelReporting: ModelReportingLevel;
  login: LoginKind;
  capabilities: { kind: CapabilityKind; level: EnforcementLevel }[];
  network: { stance: NetworkStance; level: EnforcementLevel }[];
}

export type LoginState = "logged_in" | "not_logged_in" | "unknown";

export interface ToolReport {
  id: ToolId;
  name: string;
  command: string;
  installed: boolean;
  path: string | null;
  /** The first line the tool's version command printed, or null. */
  version: string | null;
  /** Why the tool counts as not installed, or why its version is unknown; null when neither. */
  problem: string | null;
  login: { state: LoginState; detail: string };
  /** The adapter this build has for the tool, or null: then no capability can be applied through it yet. */
  adapter: AdapterReport | null;
  /** Installed, with an adapter in this build, and not known to be logged out: what `ahp init` may use. */
  usable: boolean;
}

export interface DoctorReport {
  system: SystemReport;
  tools: ToolReport[];
  /** False when Node or git does not meet its requirement. A missing tool does not make it false. */
  ok: boolean;
}

/** The Node major version `package.json` requires (`engines.node`, such as ">=24"). */
export function requiredNodeMajor(): number {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { engines: { node: string } };
  return Number(/\d+/.exec(pkg.engines.node)![0]);
}

/** Looks at this machine and reports what AHP can use on it. Runs only version and login-status commands, never a prompt. */
export async function diagnose(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const registry = options.adapters ?? registeredAdapters;
  const probing = { env, clock: options.clock, timeoutMs: options.timeoutMs, cwd: tmpdir() };

  const [git, tools] = await Promise.all([
    probe("git", ["--version"], probing),
    Promise.all(TOOLS.map((tool) => reportTool(tool, registry, platform, probing))),
  ]);
  const system = systemReport(git, platform, env, options.nodeVersion ?? process.versions.node);
  return { system, tools, ok: system.node.meets && system.git.meets };
}

function systemReport(git: ProbeResult, platform: string, env: NodeJS.ProcessEnv, nodeVersion: string): SystemReport {
  let label: string | null = null;
  try {
    label = osLabelOf(platform, env);
  } catch {
    // A system the support matrix has no label for.
  }
  const requiredNode = requiredNodeMajor();
  return {
    os: { platform, release: release(), label, supported: label !== null },
    node: { version: nodeVersion, required: `${requiredNode} or newer`, meets: Number(nodeVersion.split(".")[0]) >= requiredNode },
    git: gitReport(git),
  };
}

function gitReport(result: ProbeResult): SystemReport["git"] {
  const required = `${MINIMUM_GIT.major}.${MINIMUM_GIT.minor} or newer`;
  if (result.outcome !== "exited" || result.exitCode !== 0) {
    return { version: null, required, meets: false, detail: result.outcome === "exited" ? `\`git --version\` exited with code ${result.exitCode}` : result.message };
  }
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(result.stdout);
  if (!match) return { version: null, required, meets: false, detail: "could not read a version from `git --version`" };
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const meets = major > MINIMUM_GIT.major || (major === MINIMUM_GIT.major && minor >= MINIMUM_GIT.minor);
  return { version: match[0], required, meets, detail: null };
}

type Probing = Parameters<typeof probe>[2];

async function reportTool(tool: ToolDefinition, registry: ReadonlyMap<string, Adapter>, platform: string, probing: Probing): Promise<ToolReport> {
  const adapter = registry.get(tool.adapter);
  const base = { id: tool.id, name: tool.name, command: tool.command, adapter: adapter ? adapterReport(adapter, platform) : null };
  const found = await probe(tool.command, tool.versionArgs, probing);
  if (found.outcome === "not_found") {
    return { ...base, installed: false, path: null, version: null, problem: found.message, login: { state: "unknown", detail: "not installed" }, usable: false };
  }
  const versionLine = found.outcome === "exited" && found.exitCode === 0 ? firstLine(found.stdout) : null;
  const problem =
    found.outcome === "exited"
      ? found.exitCode === 0 && versionLine
        ? null
        : `\`${tool.command} ${tool.versionArgs.join(" ")}\` ${found.exitCode === 0 ? "printed no version" : `exited with code ${found.exitCode}`}`
      : found.message;
  const login = await loginOf(tool, probing);
  return {
    ...base,
    installed: true,
    path: found.outcome === "exited" ? found.path : null,
    version: versionLine,
    problem,
    login,
    usable: adapter !== undefined && login.state !== "not_logged_in",
  };
}

function adapterReport(adapter: Adapter, platform: string): AdapterReport {
  const { declaration } = adapter;
  return {
    name: declaration.name,
    transport: declaration.transport,
    modelReporting: declaration.modelReporting,
    login: declaration.login,
    capabilities: CAPABILITY_KINDS.map((kind) => ({ kind, level: levelOn(declaration.capabilities[kind], platform) })),
    network: NETWORK_STANCES.map((stance) => ({ stance, level: levelOn(declaration.network[stance], platform) })),
  };
}

/**
 * Asks the tool itself, through its own status command, and reads only the answer: a boolean, or an exit code. What the
 * command printed besides is dropped, and nothing outside the tool's own commands is looked at.
 */
async function loginOf(tool: ToolDefinition, probing: Probing): Promise<ToolReport["login"]> {
  const { login } = tool;
  if (login.kind === "none") return { state: "unknown", detail: `${login.why}` };
  const asked = `\`${tool.command} ${login.args.join(" ")}\``;
  const result = await probe(tool.command, login.args, probing);
  if (result.outcome !== "exited") return { state: "unknown", detail: `${asked} ${result.outcome === "timed_out" ? result.message : "could not be run"}` };
  if (login.kind === "exit_code") {
    if (result.exitCode === 0) return { state: "logged_in", detail: `${asked} exited 0` };
    if (result.exitCode === login.loggedOut) return { state: "not_logged_in", detail: `${asked} exited ${login.loggedOut}` };
    return { state: "unknown", detail: `${asked} exited with code ${result.exitCode}` };
  }
  let loggedIn: unknown;
  try {
    loggedIn = (JSON.parse(result.stdout) as { loggedIn?: unknown }).loggedIn;
  } catch {
    // Not JSON: the tool says nothing AHP can read.
  }
  if (typeof loggedIn !== "boolean") return { state: "unknown", detail: `${asked} did not say \`loggedIn\`` };
  return { state: loggedIn ? "logged_in" : "not_logged_in", detail: `${asked} said loggedIn: ${loggedIn}` };
}
