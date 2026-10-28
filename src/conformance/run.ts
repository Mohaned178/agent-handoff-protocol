// The adapter conformance suite (seam 2): every check drives the adapter through its contract only, with a coding agent
// the subject provokes, and says what it saw. It returns data, so a result can be recorded as a support-matrix cell.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AttemptExit, StartedAttempt } from "../adapters/contract.ts";
import {
  CAPABILITY_KINDS,
  ENFORCEMENT_LEVELS,
  LOGIN_KINDS,
  MODEL_REPORTING_LEVELS,
  NETWORK_STANCES,
  OPERATING_SYSTEMS,
  PROTOCOL_VERSION,
  TRANSPORT_KINDS,
  isUsageReport,
  levelOn,
  meetsLevel,
  type AppliedCapabilities,
  type CapabilityKind,
  type CapabilityRequest,
  type EnforcementLevel,
  type FailureClass,
  type HandoffRevision,
  type NetworkStance,
} from "../protocol/index.ts";
import { classifyAttempt, requestsOf, resolveCapabilities, systemClock, type Clock } from "../runtime/index.ts";
import { git } from "../runtime/git.ts";
import { sharedRefs } from "../runtime/refs.ts";
import {
  MOCK_TOOL_VERSION,
  SUITE_VERSION,
  osLabelOf,
  type CheckResult,
  type ConformanceResult,
  type OsLabel,
} from "./result.ts";
import type { ConformanceSubject, Provoked, ProvokerContext, Scenario } from "./subject.ts";

/** The suite was asked to do something it must not: a real adapter in CI, or a result with no tool version. */
export class ConformanceRefusedError extends Error {}

export interface ConformanceOptions {
  /** Stamps the result. */
  clock?: Pick<Clock, "now">;
  /**
   * The system whose declared levels are checked (default `process.platform`). For tests: the agent itself always runs
   * on this machine, so a result made with another platform describes a declaration, not a system, and is never recorded.
   */
  platform?: string;
  /** Read for `CI`: a real adapter is never run in CI. */
  env?: NodeJS.ProcessEnv;
  /** The tool's version, if the subject cannot say. */
  toolVersion?: string;
  /** The label for the system, if it is not what `osLabelOf` finds. */
  osLabel?: OsLabel;
  /** How long an attempt gets to end by itself (default 120 000 ms). */
  timeoutMs?: number;
  /** CheckContext only the checks with these IDs, to look at one; the others are recorded as skipped, so the result is untested. */
  only?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** What a check found out of the ordinary: it did not hold. Anything else a check throws is the adapter's failure too. */
class Failure extends Error {}
function fail(message: string): never {
  throw new Failure(message);
}

type Outcome = Pick<CheckResult, "status" | "detail">;
const passed = (detail: string): Outcome => ({ status: "passed", detail });
const skipped = (detail: string): Outcome => ({ status: "skipped", detail });
const notApplicable = (detail: string): Outcome => ({ status: "not_applicable", detail });

/** Runs the whole suite against `subject` and returns what each check found. */
export async function runConformance(subject: ConformanceSubject, options: ConformanceOptions = {}): Promise<ConformanceResult> {
  const { declaration } = subject.adapter;
  const env = options.env ?? process.env;
  if (!declaration.mock && (env.CI || env.GITHUB_ACTIONS)) {
    throw new ConformanceRefusedError(`adapter "${declaration.name}" drives a real tool: its conformance suite is run on the maintainer's machine, never in CI`);
  }
  const toolVersion = declaration.mock ? MOCK_TOOL_VERSION : (options.toolVersion ?? (await subject.toolVersion?.()));
  if (!toolVersion?.trim()) {
    throw new ConformanceRefusedError(`adapter "${declaration.name}" has no tool version: give one, a version is never made up`);
  }
  const platform = options.platform ?? process.platform;
  const run: CheckContext = { subject, platform, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, cleanups: [] };
  const checks: CheckResult[] = [];
  for (const { id, check } of CHECKS) {
    if (options.only && !options.only.includes(id)) {
      checks.push({ id, ...skipped("not selected") });
      continue;
    }
    let outcome: Outcome;
    try {
      outcome = await check(run);
    } catch (error) {
      outcome = { status: "failed", detail: error instanceof Failure ? error.message : `the adapter threw: ${(error as Error).message}` };
    } finally {
      await cleanUp(run);
    }
    checks.push({ id, ...outcome });
  }
  return {
    suiteVersion: SUITE_VERSION,
    adapter: declaration.name,
    mock: declaration.mock,
    platform: process.platform,
    osLabel: options.osLabel ?? osLabelOf(process.platform, env),
    toolVersion,
    ranAt: (options.clock ?? systemClock).now().toISOString(),
    checks,
  };
}

// ---------------------------------------------------------------------------
// One attempt, driven through the contract

interface CheckContext {
  subject: ConformanceSubject;
  platform: string;
  timeoutMs: number;
  /** Undone after the check, whatever it found: no agent process or temporary directory outlives a check. */
  cleanups: (() => Promise<void>)[];
}

interface Ran {
  workspace: string;
  context: ProvokerContext;
  provoked: Provoked;
  started: StartedAttempt;
  applied: AppliedCapabilities;
  /** The workspace's commit and the repository's shared refs just before the agent started. */
  before: Snapshot;
}

async function cleanUp(run: CheckContext): Promise<void> {
  for (const cleanup of run.cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // best effort: the check's own result is what matters
    }
  }
}

const DEFAULT_REQUESTED_MODEL = "conformance-requested-model";
const SCOPE = "scope";

/** The capabilities and stance the runtime would record for an agent step that asks for `capabilities`, at the declared levels. */
function appliedFor(run: CheckContext, capabilities: CapabilityRequest[] = []): AppliedCapabilities {
  const requests = requestsOf({ capabilities });
  return resolveCapabilities(requests, run.subject.adapter.declaration, run.platform).applied;
}

async function workspaceOf(run: CheckContext): Promise<string> {
  const workspace = mkdtempSync(join(tmpdir(), "ahp-conformance-"));
  run.cleanups.push(async () => rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  await git(workspace, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(workspace, "README.md"), "conformance workspace\n");
  mkdirSync(join(workspace, SCOPE));
  writeFileSync(join(workspace, SCOPE, ".gitkeep"), "");
  await git(workspace, ["add", "--all"]);
  await git(workspace, ["-c", "user.name=AHP Conformance", "-c", "user.email=conformance@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "--message", "workspace"]);
  return workspace;
}

/** Starts the attempt for `scenario`; null when the subject has no provoker for it. */
async function start(
  run: CheckContext,
  scenario: Scenario,
  options: { applied?: AppliedCapabilities; networkUrl?: string } = {},
): Promise<Ran | null> {
  const provoker = run.subject.provokers[scenario];
  if (!provoker) return null;
  const { adapter } = run.subject;
  const workspace = await workspaceOf(run);
  const pidDir = mkdtempSync(join(tmpdir(), "ahp-conformance-pids-"));
  run.cleanups.push(async () => rmSync(pidDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const requestedModel = run.subject.requestedModel ?? DEFAULT_REQUESTED_MODEL;
  const context: ProvokerContext = {
    requestedModel,
    probeFile: "probe.txt",
    probeContent: "conformance probe\n",
    scope: SCOPE,
    outsideFile: "outside/probe.txt",
    branch: "conformance-probe",
    networkUrl: options.networkUrl ?? "http://127.0.0.1:9/",
    pidFile: join(pidDir, "pids"),
  };
  const provoked = provoker(context);
  const problems = adapter.validateOptions(provoked.options);
  if (problems.length > 0) fail(`the subject's provoker for "${scenario}" gave options the adapter rejects: ${problems.join("; ")}`);
  const applied = options.applied ?? appliedFor(run);
  const before = await snapshotOf(workspace);
  const handoff = handoffFor(before.head, adapter.declaration.name, requestedModel, applied);
  const started = await adapter.startAttempt({
    attemptId: `att_conformance${scenario.replaceAll("_", "")}`,
    attemptNumber: 1,
    workspace,
    requestedModel,
    capabilities: applied,
    handoff,
    options: provoked.options,
    toolCallLog: join(pidDir, "tool-calls.jsonl"),
  });
  run.cleanups.push(async () => {
    // Whatever the check found, the agent and everything it started must not outlive it.
    await started.cancel({ graceMs: 200 });
    for (const pid of pidsListed(context.pidFile)) killQuietly(pid);
  });
  return { workspace, context, provoked, started, applied, before };
}

const pidsListed = (file: string): number[] => {
  try {
    const text = readFileSync(file, "utf8");
    // Whole lines only (the agent may still be writing the last), and only PIDs that name a process: a kill of 0 or -1 reaches far more than the agent's tree.
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(Number).filter((pid) => Number.isInteger(pid) && pid > 1);
  } catch {
    return [];
  }
};

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A revision-1 handoff for the attempt, as the runtime would make it for a step that asks for `applied`. */
function handoffFor(commit: string, adapter: string, requestedModel: string, applied: AppliedCapabilities): HandoffRevision {
  return {
    schemaVersion: PROTOCOL_VERSION,
    handoffId: "hnd_conformance",
    revision: 1,
    supersedes: null,
    contextId: "run_conformance",
    from: null,
    to: { stepId: "conformance", adapter, requestedModel },
    base: { commit },
    contract: {
      instructions: "Conformance suite attempt: do what the adapter's options say.",
      acceptance: { verificationCommand: null, requiredOutputFields: [] },
    },
    capabilities: applied.capabilities.map(({ level: _level, ...request }) => request),
    network: { stance: applied.network.stance, require: applied.network.require },
    context: { fields: {} },
    artifacts: [],
    evidence: [],
    requires: { fields: [], artifacts: [] },
  };
}

/** Waits for the attempt to end by itself. */
async function exitOf(run: CheckContext, ran: Ran): Promise<AttemptExit> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Failure(`the agent had not exited ${run.timeoutMs} ms after it started`)), run.timeoutMs);
  });
  try {
    return await Promise.race([ran.started.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The attempt for `scenario`, ended; or null (and nothing started) when the subject cannot provoke it. */
async function ranToEnd(run: CheckContext, scenario: Scenario, options?: Parameters<typeof start>[2]): Promise<{ ran: Ran; exit: AttemptExit } | null> {
  const ran = await start(run, scenario, options);
  return ran && { ran, exit: await exitOf(run, ran) };
}

/** A scenario the subject declares its tool cannot be made to do is `unprovokable`; one it merely has no provoker for is skipped. */
const cannotProvoke = (run: CheckContext, scenario: Scenario): Outcome => {
  const detail = `the subject cannot make its agent do "${scenario}"`;
  return run.subject.unprovokable?.includes(scenario) ? { status: "unprovokable", detail } : skipped(detail);
};

// ---------------------------------------------------------------------------
// The checks

type Check = (run: CheckContext) => Promise<Outcome>;

async function declarationComplete({ subject }: CheckContext): Promise<Outcome> {
  const { declaration } = subject.adapter;
  const problems: string[] = [];
  if (!declaration.name.trim()) problems.push("no name");
  if (!TRANSPORT_KINDS.includes(declaration.transport)) problems.push(`transport "${declaration.transport}" is not one of ${TRANSPORT_KINDS.join(", ")}`);
  if (!MODEL_REPORTING_LEVELS.includes(declaration.modelReporting)) problems.push(`modelReporting "${declaration.modelReporting}" is not a level`);
  if (!LOGIN_KINDS.includes(declaration.login)) problems.push(`login "${declaration.login}" is not a kind`);
  if (typeof declaration.gracefulCancel !== "boolean") problems.push("gracefulCancel is not stated");
  const levels: [string, Record<string, EnforcementLevel> | undefined][] = [
    ...CAPABILITY_KINDS.map((kind): [string, Record<string, EnforcementLevel> | undefined] => [`capability ${kind}`, declaration.capabilities?.[kind]]),
    ...NETWORK_STANCES.map((stance): [string, Record<string, EnforcementLevel> | undefined] => [`network stance ${stance}`, declaration.network?.[stance]]),
  ];
  for (const [what, byOs] of levels) {
    for (const os of OPERATING_SYSTEMS) {
      const level = byOs?.[os];
      if (!level || !ENFORCEMENT_LEVELS.includes(level)) problems.push(`${what} has no level on ${os}`);
    }
  }
  return problems.length > 0 ? fail(`the declaration is incomplete: ${problems.join("; ")}`) : passed("transport, model reporting, login, graceful cancel and a level for every capability, stance and operating system");
}

async function spawnAndExit(run: CheckContext): Promise<Outcome> {
  const result = await ranToEnd(run, "completes");
  if (!result) return cannotProvoke(run, "completes");
  const { ran, exit } = result;
  if (!Number.isInteger(ran.started.pid) || ran.started.pid <= 0) fail(`the attempt's pid is ${ran.started.pid}, not a process ID`);
  if (exit.exitCode !== 0 || exit.signal !== null) fail(`the agent that completed its work exited with code ${exit.exitCode} and signal ${exit.signal}`);
  if (exit.error !== null) fail(`the adapter reported an error for an attempt that completed: ${exit.error.message}`);
  const summary = exit.reportedOutput.summary;
  const isText = typeof summary === "string" ? summary.trim() !== "" : Array.isArray(summary) && summary.length > 0;
  if (!isText) fail(`the adapter did not normalize the agent's \`summary\` into reportedOutput (got ${JSON.stringify(summary)})`);
  const written = readIfExists(join(ran.workspace, ran.context.probeFile));
  if (written !== ran.context.probeContent) fail(`the agent's file is not in the attempt's workspace as it wrote it (got ${JSON.stringify(written)})`);
  return passed(`started as process ${ran.started.pid}, exited 0, reported its summary, and its file is in the workspace`);
}

const readIfExists = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The failure class the runtime gives an attempt that ended like the agent did. */
const failureCheck =
  (scenario: Scenario, expected: FailureClass): Check =>
  async (run) => {
    const result = await ranToEnd(run, scenario);
    if (!result) return cannotProvoke(run, scenario);
    const { exit } = result;
    const got = classifyAttempt({ ...exit, verdict: null });
    if (got !== expected) {
      fail(`the attempt classifies as ${got === null ? "no failure" : `"${got}"`}, not "${expected}" (exit code ${exit.exitCode}, error ${JSON.stringify(exit.error)})`);
    }
    return passed(`classifies as "${expected}" (exit code ${exit.exitCode}, error ${exit.error ? `"${exit.error.kind}"` : "none"})`);
  };

async function modelReported(run: CheckContext): Promise<Outcome> {
  const result = await ranToEnd(run, "reports_model");
  if (!result) return cannotProvoke(run, "reports_model");
  const { exit, ran } = result;
  const told = ran.provoked.told?.model;
  if (typeof exit.reportedModel !== "string" || exit.reportedModel.trim() === "") fail(`the tool named its model and the adapter reported ${JSON.stringify(exit.reportedModel)}`);
  if (told !== undefined && exit.reportedModel !== told) fail(`the tool said "${told}" and the adapter reported "${exit.reportedModel}"`);
  if (told === undefined && exit.reportedModel === ran.context.requestedModel) {
    return skipped(`the adapter reported the requested model "${exit.reportedModel}", and the subject cannot make the tool say another, so an echo of the request cannot be told from a report`);
  }
  return passed(`reported "${exit.reportedModel}", which is what the tool said (the requested model was "${ran.context.requestedModel}")`);
}

async function modelNotReported(run: CheckContext): Promise<Outcome> {
  const result = await ranToEnd(run, "no_model_report");
  if (!result) return cannotProvoke(run, "no_model_report");
  if (result.exit.reportedModel !== null) {
    fail(`the tool said nothing about its model, and the adapter reported "${result.exit.reportedModel}" (the requested model was "${result.ran.context.requestedModel}"): a reported model is never filled in from the request`);
  }
  return passed("reported no model when the tool named none, though one was requested");
}

const USAGE_NUMBERS = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cost"] as const;

async function usageReported(run: CheckContext): Promise<Outcome> {
  const result = await ranToEnd(run, "reports_usage");
  if (!result) return cannotProvoke(run, "reports_usage");
  const { usage } = result.exit;
  if (usage === null) fail("the tool reported usage and the adapter reported none");
  if (!isUsageReport(usage)) fail(`the adapter's usage is not a report a tool could have made (a source is required and no number may be negative or missing): ${JSON.stringify(usage)}`);
  const told = result.ran.provoked.told?.usage;
  if (told) {
    // A number the tool did not give is null, never 0.
    for (const key of USAGE_NUMBERS) {
      const expected = told[key] ?? null;
      if (JSON.stringify(usage![key]) !== JSON.stringify(expected)) fail(`the tool reported ${key} ${JSON.stringify(expected)} and the adapter reported ${JSON.stringify(usage![key])}`);
    }
  }
  return passed(`reported usage labelled with its source "${usage!.source}"${told ? ", and every number is what the tool gave, the others null" : ""}`);
}

async function usageNotReported(run: CheckContext): Promise<Outcome> {
  const result = await ranToEnd(run, "no_usage_report");
  if (!result) return cannotProvoke(run, "no_usage_report");
  if (result.exit.usage !== null) fail(`the tool reported no usage, and the adapter reported ${JSON.stringify(result.exit.usage)}: usage is never estimated or filled in`);
  return passed("reported no usage when the tool gave none");
}

/** How a cancel is expected to go: by the transport if the adapter has one, else SIGTERM on Linux and macOS and a tree kill on Windows. */
const expectedCancel = (gracefulCancel: boolean) =>
  gracefulCancel
    ? ({ forced: false, via: "transport" } as const)
    : process.platform === "win32"
      ? ({ forced: true, via: "tree_kill" } as const)
      : ({ forced: false, via: "signal" } as const);

async function cancelStopsAgent(run: CheckContext): Promise<Outcome> {
  const ran = await start(run, "hangs");
  if (!ran) return cannotProvoke(run, "hangs");
  const termination = await ran.started.cancel({ graceMs: 5_000 });
  const expected = expectedCancel(run.subject.adapter.declaration.gracefulCancel);
  if (termination.outcome === "already_gone") fail("the agent that was to hang was already gone when it was cancelled");
  if (termination.outcome === "unconfirmed") fail(`the cancel could not confirm the agent gone: ${termination.detail}`);
  if (termination.forced !== expected.forced || termination.via !== expected.via) {
    fail(`the cancel ${JSON.stringify({ forced: termination.forced, via: termination.via })}, expected ${JSON.stringify(expected)}`);
  }
  await exitOf(run, ran);
  if (isRunning(ran.started.pid)) fail(`process ${ran.started.pid} is still running after the cancel`);
  return passed(`stopped the hung agent (${termination.via}, forced: ${termination.forced}) and it is gone`);
}

async function cancelForcedTree(run: CheckContext): Promise<Outcome> {
  const ran = await start(run, "resists_cancel");
  if (!ran) return cannotProvoke(run, "resists_cancel");
  const deadline = Date.now() + 30_000;
  while (pidsListed(ran.context.pidFile).length === 0) {
    if (Date.now() > deadline) fail(`the agent did not list the processes it started in ${ran.context.pidFile} within 30 s`);
    await sleep(50);
  }
  const tree = [ran.started.pid, ...pidsListed(ran.context.pidFile)];
  const termination = await ran.started.cancel({ graceMs: 300 });
  if (termination.outcome === "unconfirmed") fail(`the cancel could not confirm the tree gone: ${termination.detail}`);
  if (termination.outcome !== "stopped") fail(`the cancel reported ${JSON.stringify(termination)}, not a stop`);
  // An adapter with no transport cancel can only stop processes that ignore signals by a tree kill. One with a transport
  // cancel may clear the tree by it (OpenCode's does, and on Windows no process can ignore being terminated): forcing is
  // for what the transport leaves, and what the cancel reports is then checked against the PIDs all the same.
  const graceful = run.subject.adapter.declaration.gracefulCancel;
  if (!graceful && (!termination.forced || termination.via !== "tree_kill")) {
    fail(`processes that ignore every signal can only be stopped by a tree kill; the cancel reported ${JSON.stringify(termination)}`);
  }
  // The cancel's own confirmation is a claim; the PIDs are the evidence.
  const survivors = await survivorsAfter(tree);
  if (survivors.length > 0) fail(`the cancel reported the tree stopped, and processes ${survivors.join(", ")} are still running`);
  const how = termination.forced ? "killed" : "stopped, without force, by the transport's own cancel,";
  return passed(`${how} the tree of ${tree.length} processes, which ignored every signal (${termination.via}), and none is left`);
}

async function survivorsAfter(pids: number[]): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const alive = pids.filter(isRunning);
    if (alive.length === 0 || Date.now() > deadline) return alive;
    await sleep(100);
  }
}

const LEVEL_NOTE =
  "cooperative is a request the agent may ignore, not enforcement: the suite checks that the attempt accepts it, not that the agent obeys";

/** How an agent tries to break a capability or a network stance, and how to see that it did. */
interface Probe {
  scenario: Scenario;
  /** Whether the probe needs the suite's local listener, whose requests `violation` is given. */
  network?: boolean;
  /** What the agent did that the capability forbids; null when it left everything as it was. */
  violation: (ran: Ran, requests: readonly string[]) => Promise<string | null>;
}

const PROBES: Record<CapabilityKind, Probe> = {
  read_only: {
    scenario: "writes_when_read_only",
    violation: async (ran) => {
      const changed = await changedSince(ran.workspace, ran.before);
      return changed.length > 0 ? `changed ${changed.join(", ")}` : null;
    },
  },
  write_scope: {
    scenario: "writes_outside_scope",
    violation: async (ran) => {
      const outside = (await changedSince(ran.workspace, ran.before)).filter((path) => !path.startsWith(`${ran.context.scope}/`));
      return outside.length > 0 ? `changed ${outside.join(", ")}, outside "${ran.context.scope}"` : null;
    },
  },
  no_external_actions: {
    scenario: "branches_in_shared_repo",
    violation: async (ran) => {
      const now = JSON.stringify(await sharedRefs(ran.workspace));
      return now !== ran.before.refs ? "changed a shared ref" : null;
    },
  },
};

// A listener on this machine is not a package registry, so either stance must keep the agent from it.
const NETWORK_PROBE: Probe = {
  scenario: "fetches_when_denied",
  network: true,
  violation: async (_ran, requests) => (requests.length > 0 ? `reached the suite's local listener (${requests.length} request)` : null),
};

interface Snapshot {
  head: string;
  refs: string;
}

async function snapshotOf(workspace: string): Promise<Snapshot> {
  return { head: await git(workspace, ["rev-parse", "HEAD"]), refs: JSON.stringify(await sharedRefs(workspace)) };
}

/** Paths changed in the workspace since `before`, in the working tree or by a commit. */
async function changedSince(workspace: string, before: Snapshot): Promise<string[]> {
  const status = await git(workspace, ["status", "--porcelain", "--untracked-files=all"]);
  const paths = new Set(status.split("\n").filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, "")));
  const head = await git(workspace, ["rev-parse", "HEAD"]);
  if (head !== before.head) for (const path of (await git(workspace, ["diff", "--name-only", before.head, head])).split("\n").filter(Boolean)) paths.add(path);
  return [...paths];
}

/** A capability request for `kind` that requires nothing, so that the declared level is what is applied. */
const requestFor = (kind: CapabilityKind): CapabilityRequest => (kind === "write_scope" ? { kind, paths: [SCOPE], require: "none" } : { kind, require: "none" });

/** The same attempt with every level recorded as `none`: the adapter is asked to apply nothing. */
const unenforced = (applied: AppliedCapabilities): AppliedCapabilities => ({
  ...applied,
  capabilities: applied.capabilities.map((capability) => ({ ...capability, level: "none" as const })),
  network: { ...applied.network, level: "none" },
});

/** A declared `cooperative` level: the attempt runs to completion with it applied, which is all the suite can see. */
async function acceptedAtCooperative(run: CheckContext, what: string, applied: AppliedCapabilities): Promise<Outcome> {
  const result = await ranToEnd(run, "completes", { applied });
  if (!result) return cannotProvoke(run, "completes");
  if (result.exit.exitCode !== 0) fail(`the attempt did not run to completion with ${what} applied at "cooperative" (exit code ${result.exit.exitCode})`);
  return passed(`accepted at "cooperative" on ${run.platform}. ${LEVEL_NOTE}`);
}

/** Lets the agent try `probe` with `applied` recorded; what it broke, null when nothing, undefined when the subject cannot provoke it. */
async function tryBreak(run: CheckContext, probe: Probe, applied: AppliedCapabilities): Promise<string | null | undefined> {
  const requests: string[] = [];
  let networkUrl: string | undefined;
  if (probe.network) {
    const server = createServer((request, response) => {
      requests.push(request.url ?? "/");
      response.end("conformance");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    run.cleanups.push(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
    networkUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/conformance`;
  }
  const result = await ranToEnd(run, probe.scenario, { applied, networkUrl });
  // How the agent ended does not matter, only what it left behind: a tool may stop an agent for trying.
  return result ? probe.violation(result.ran, requests) : undefined;
}

/**
 * A declared `enforced_by_tool` level: the agent tries to break it and must fail to. A control run first has the same
 * agent try with the level recorded as `none`, and must succeed: an agent that crashes, never reaches the attempt, or
 * a probe that breaks nothing would otherwise pass for enforcement.
 */
async function enforcedProbe(run: CheckContext, probe: Probe, what: string, applied: AppliedCapabilities): Promise<Outcome> {
  const control = await tryBreak(run, probe, unenforced(applied));
  if (control === undefined) return cannotProvoke(run, probe.scenario);
  if (control === null) {
    return skipped(`the "${probe.scenario}" probe broke nothing even with the level recorded as "none", so it cannot show that anything is enforced`);
  }
  const violation = await tryBreak(run, probe, applied);
  if (violation) fail(`declared "enforced_by_tool" for ${what} on ${run.platform}, and the agent ${violation}`);
  return passed(`declared "enforced_by_tool" on ${run.platform}: the same agent ${control} when nothing was applied, and nothing under ${what}`);
}

const capabilityCheck =
  (kind: CapabilityKind): Check =>
  async (run) => {
    const declared = levelOn(run.subject.adapter.declaration.capabilities[kind], run.platform);
    if (declared === "none") return notApplicable(`declared "none" on ${run.platform}: nothing is applied`);
    const applied = appliedFor(run, [requestFor(kind)]);
    return declared === "cooperative" ? acceptedAtCooperative(run, kind, applied) : enforcedProbe(run, PROBES[kind], kind, applied);
  };

const networkCheck =
  (stance: NetworkStance): Check =>
  async (run) => {
    const declared = levelOn(run.subject.adapter.declaration.network[stance], run.platform);
    if (declared === "none") return notApplicable(`declared "none" on ${run.platform}: nothing is applied`);
    const applied = resolveCapabilities({ ...requestsOf({}), network: { stance, require: "none" } }, run.subject.adapter.declaration, run.platform).applied;
    const what = `the "${stance}" stance`;
    return declared === "cooperative" ? acceptedAtCooperative(run, what, applied) : enforcedProbe(run, NETWORK_PROBE, what, applied);
  };

/** The contract: an adapter throws rather than apply a capability at a weaker level than the one recorded. */
async function refusesAboveDeclared(run: CheckContext): Promise<Outcome> {
  const { declaration } = run.subject.adapter;
  const weak = CAPABILITY_KINDS.find((kind) => !meetsLevel(levelOn(declaration.capabilities[kind], run.platform), "enforced_by_tool"));
  if (weak === undefined) return notApplicable(`every capability is declared "enforced_by_tool" on ${run.platform}`);
  const declared = levelOn(declaration.capabilities[weak], run.platform);
  const honest = appliedFor(run, [requestFor(weak)]);
  const claimed: AppliedCapabilities = {
    ...honest,
    capabilities: honest.capabilities.map((capability) => (capability.kind === weak ? { ...capability, level: "enforced_by_tool" } : capability)),
  };
  let ran: Ran | null;
  try {
    ran = await start(run, "completes", { applied: claimed });
  } catch (error) {
    return passed(`declares ${weak} "${declared}" on ${run.platform} and refused to apply it at "enforced_by_tool": ${(error as Error).message}`);
  }
  if (!ran) return cannotProvoke(run, "completes");
  return fail(`declares ${weak} "${declared}" on ${run.platform}, and started an attempt recorded as applying it at "enforced_by_tool"`);
}

/** The checks the suite makes, in order. */
const CHECKS: { id: string; check: Check }[] = [
  { id: "declaration:complete", check: declarationComplete },
  { id: "spawn_and_exit", check: spawnAndExit },
  { id: "failure:agent_error", check: failureCheck("fails", "agent_error") },
  { id: "failure:config_auth", check: failureCheck("login_problem", "config_auth") },
  { id: "failure:transient", check: failureCheck("rate_limited", "transient") },
  { id: "model:reported", check: modelReported },
  { id: "model:not_reported", check: modelNotReported },
  { id: "usage:reported", check: usageReported },
  { id: "usage:not_reported", check: usageNotReported },
  { id: "cancel:stops_agent", check: cancelStopsAgent },
  { id: "cancel:forced_tree", check: cancelForcedTree },
  ...CAPABILITY_KINDS.map((kind) => ({ id: `capability:${kind}`, check: capabilityCheck(kind) })),
  ...NETWORK_STANCES.map((stance) => ({ id: `network:${stance}`, check: networkCheck(stance) })),
  { id: "declaration:refuses_above_declared", check: refusesAboveDeclared },
];

/** The ID of every check of the current suite: a result missing one of them is not a result of it. Change this list only with `SUITE_VERSION`. */
export const CHECK_IDS: readonly string[] = CHECKS.map(({ id }) => id);
