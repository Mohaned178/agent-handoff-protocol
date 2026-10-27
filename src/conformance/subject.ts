// What an adapter supplies for the conformance suite: itself, and a way to make its coding agent do each thing the suite
// checks. The suite never scripts a real tool: a subject that cannot provoke a behaviour leaves it out, and the check for
// it is skipped, never passed.

import type { Adapter } from "../adapters/contract.ts";
import type { UsageReport } from "../protocol/index.ts";

/**
 * Everything the suite asks a coding agent to do, a closed list. A provoker for one makes the agent do exactly that, in
 * the attempt workspace the suite gives it.
 * - `completes`: write `probeFile` with `probeContent`, report a `summary` output field, and exit 0.
 * - `fails`: exit non-zero with nothing the adapter would call a login or rate limit problem.
 * - `login_problem`: the tool is not logged in.
 * - `rate_limited`: the tool or its provider says to wait (a rate limit, a quota).
 * - `reports_model` / `no_model_report`: the tool says which model it ran / says nothing about it.
 * - `reports_usage` / `no_usage_report`: the tool reports what it used / reports nothing.
 * - `hangs`: do nothing until stopped.
 * - `resists_cancel`: start a process that ignores every termination signal, write the PIDs of the processes it started
 *   (not its own) to `pidFile`, one per line, then hang ignoring them too.
 * - `writes_when_read_only`: write `probeFile`, as if it had not been told to change nothing.
 * - `writes_outside_scope`: write `outsideFile`, which is not under `scope`.
 * - `branches_in_shared_repo`: create the git branch `branch` in the repository.
 * - `fetches_when_denied`: request `networkUrl`, a host that is not a package registry.
 */
export const SCENARIOS = [
  "completes",
  "fails",
  "login_problem",
  "rate_limited",
  "reports_model",
  "no_model_report",
  "reports_usage",
  "no_usage_report",
  "hangs",
  "resists_cancel",
  "writes_when_read_only",
  "writes_outside_scope",
  "branches_in_shared_repo",
  "fetches_when_denied",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Where and what a provoker is to act on, all inside the attempt's own workspace or the suite's local server. */
export interface ProvokerContext {
  /** The model the attempt requests: what a tool that reports nothing must not be credited with. */
  requestedModel: string;
  probeFile: string;
  probeContent: string;
  /** A repository-relative directory a `write_scope` capability allows. */
  scope: string;
  /** A repository-relative file that is not under `scope`. */
  outsideFile: string;
  branch: string;
  /** A URL on this machine that the suite counts requests to. */
  networkUrl: string;
  /** An absolute path for the `resists_cancel` agent to list its processes in. */
  pidFile: string;
}

/** The numbers a subject made its tool report, to compare with what the adapter says it reported. */
export type ToldUsage = Partial<Omit<UsageReport, "source">>;

export interface Provoked {
  /** The adapter options that make the coding agent do it (`Adapter.validateOptions` accepts them). */
  options: unknown;
  /**
   * What the tool was made to say, when the subject can make it say exactly this (a scripted tool can; a real one
   * cannot): the check then compares the adapter's normalization with it, instead of checking only its shape.
   */
  told?: { model?: string; usage?: ToldUsage };
}

export type Provoker = (context: ProvokerContext) => Provoked;

export interface ConformanceSubject {
  adapter: Adapter;
  provokers: Partial<Record<Scenario, Provoker>>;
  /**
   * The model every attempt requests; a real tool needs one it accepts. Default: a made-up name, which only a scripted
   * tool can be told to run, so a model the adapter reports without being told it equals this is an echo of the request.
   */
  requestedModel?: string;
  /**
   * The version of the coding-agent tool under test, as the tool reports it. A subject that cannot say leaves it out
   * and the runner must be given one: a version is never made up.
   */
  toolVersion?: () => Promise<string>;
}
