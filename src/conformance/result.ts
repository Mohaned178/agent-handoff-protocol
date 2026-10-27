// What a conformance run leaves behind: one result per adapter on one operating system, recorded as a JSON file. The
// support matrix is rendered from these (`src/conformance/matrix.ts`), so a result says what was run, where, with which
// tool and when, and never more than the checks showed.

import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Bumped whenever a check is added, removed or made stricter, so a result recorded under an older suite cannot read as a
 * pass of the current one.
 */
export const SUITE_VERSION = 1;

/**
 * How a check ended. A closed list.
 * - `passed`: the behaviour was provoked and observed as the adapter declares it.
 * - `failed`: it was provoked and was not (or the adapter threw, or did not end).
 * - `skipped`: it could not be provoked (the subject has no provoker for it), so nothing is known.
 * - `not_applicable`: the declaration says there is nothing to check (a capability declared `none` on this OS).
 */
export const CHECK_STATUSES = ["passed", "failed", "skipped", "not_applicable"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface CheckResult {
  /** Stable across runs, for example `cancel:forced_tree`. */
  id: string;
  status: CheckStatus;
  /** What was seen, or why it was skipped or does not apply. */
  detail: string;
}

/** The operating-system labels a support-matrix cell can carry. A closed list: the cells are adapter × label. */
export const OS_LABELS = ["Windows", "Linux (WSL2)", "Linux", "macOS"] as const;
export type OsLabel = (typeof OS_LABELS)[number];

/** The tool version a mock result carries: there is no tool. */
export const MOCK_TOOL_VERSION = "n/a (mock)";

const CheckResultSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(CHECK_STATUSES),
  detail: z.string(),
});

export const ConformanceResultSchema = z.strictObject({
  suiteVersion: z.int().min(1),
  adapter: z.string().min(1),
  /** True for the mock adapter, which drives no tool: its results are never evidence for the matrix. */
  mock: z.boolean(),
  /** Node's `process.platform` for the run. */
  platform: z.string().min(1),
  osLabel: z.enum(OS_LABELS),
  toolVersion: z.string().min(1),
  /** When the run ended, ISO 8601. */
  ranAt: z.iso.datetime(),
  checks: z.array(CheckResultSchema),
});
export type ConformanceResult = z.infer<typeof ConformanceResultSchema>;

/**
 * `passed` when every check passed or does not apply, `failed` when any failed, and `untested` otherwise: a check that
 * was skipped leaves something unknown, and so does a run with no checks.
 */
export function outcomeOf(result: Pick<ConformanceResult, "checks">): "passed" | "failed" | "untested" {
  if (result.checks.some((check) => check.status === "failed")) return "failed";
  if (result.checks.length === 0 || result.checks.some((check) => check.status === "skipped")) return "untested";
  return "passed";
}

/**
 * The label for the system the run is on. WSL2 is Linux, and is told apart because its tool logins and filesystem are
 * separate from Windows': `WSL_DISTRO_NAME` is set inside it, and its kernel names Microsoft in `/proc/version`.
 */
export function osLabelOf(platform: string, env: NodeJS.ProcessEnv = process.env, procVersion: () => string = readProcVersion): OsLabel {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return env.WSL_DISTRO_NAME || /microsoft/i.test(procVersion()) ? "Linux (WSL2)" : "Linux";
  throw new Error(`no support-matrix label for the platform "${platform}"`);
}

function readProcVersion(): string {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}
