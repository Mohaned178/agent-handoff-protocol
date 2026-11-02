// What the home screen lists, as data: the runs waiting for a person on top, then the recent ones, each with the symbol
// that carries its state without colour. Only what the ledger says: a run is "verified" only when every check it has
// passed, a run whose ledger cannot be read is listed with its problem, and a mock run says it is one.

import type { RoleAssignment } from "../../doctor/init.ts";
import { TOOLS } from "../../doctor/tools.ts";
import { THIS_REPOSITORY, type RunView, type StepView } from "../../protocol/index.ts";
import type { RunListing } from "../../sdk/run.ts";
import { waitingDetail } from "../../commands/runs.ts";
import { sessionCasting, sessionChanges, type TaskSession } from "../../commands/task.ts";
import { SYMBOLS, type Token } from "../theme.ts";

export interface HomeRow {
  runId: string;
  symbol: string;
  tone: Token;
  /** The workflow's name, or the run ID when its ledger cannot be read. */
  title: string;
  /** "2h ago"; empty when the ledger cannot be read. */
  when: string;
  detail: string;
}

export interface HomeModel {
  waiting: HomeRow[];
  recent: HomeRow[];
  /** Runs left out of `recent`: `/runs` lists them. */
  older: number;
}

/** How many ended runs the home screen lists. */
export const RECENT_SHOWN = 8;

/** How long ago `iso` was, in its largest whole unit. */
export function ago(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const FAILURE_WORDS: Record<string, string> = {
  rejected: "handoff rejected",
  config_auth: "login, usage limit or configuration problem",
  transient: "temporary error (rate limit or network)",
  agent_error: "agent error",
  verification_failed: "check failed",
  inconclusive: "check could not run",
  unknown: "outcome unknown",
};

const agentSteps = (state: RunView) => state.steps.filter((step) => step.kind === "agent" || step.kind === "review");
const checkOf = (step: StepView) => step.attempts.map((attempt) => attempt.verification?.command ?? null).filter((command) => command !== null).at(-1) ?? step.check;

/** Where the approved work went: the last push's branch, and its remote unless it is this repository. */
function destinationOf(state: RunView): string | null {
  const push = state.steps.map((step) => step.action?.target).filter((target) => target?.kind === "push_branch").at(-1);
  if (!push) return null;
  return push.remote === THIS_REPOSITORY ? `branch ${push.branch}` : `branch ${push.branch} on ${push.remote}`;
}

function succeededDetail(state: RunView): string {
  const checked = agentSteps(state).filter((step) => checkOf(step) !== null);
  const verdict = checked.length === 0 ? "not verified: no check" : checked.every((step) => step.state === "succeeded") ? "verified" : "not verified";
  return [verdict, destinationOf(state)].filter(Boolean).join(" · ");
}

function failedDetail(state: RunView): string {
  const step = state.steps.find((candidate) => candidate.state === "failed");
  if (!step) return "failed";
  const check = checkOf(step);
  if (step.failureClass === "verification_failed" && check !== null) {
    const failures = step.attempts.filter((attempt) => attempt.verification?.state === "fail").length;
    return `${step.id}: ${check} failed${failures > 1 ? ` ${failures} times` : ""}`;
  }
  // The tool's own words first: "You've hit your usage limit" says what to do, a class name does not (ticket 10).
  const said = step.attempts.at(-1)?.error?.message.split(/\r?\n/)[0]?.trim();
  if (said) return `${step.id}: ${said}`;
  return `${step.id}: ${step.failureClass ? (FAILURE_WORDS[step.failureClass] ?? step.failureClass) : "failed"}`;
}

const mockNote = (state: RunView) => (state.mock ? " · mock" : "");

/** One run as a row, and whether it waits for a person. */
export function rowOf(listing: RunListing, now: number): { row: HomeRow; waiting: boolean } {
  const { runId, state } = listing;
  if (!state) return { row: { runId, symbol: SYMBOLS.fail, tone: "error", title: runId, when: "", detail: `cannot be read: ${listing.problem ?? "unknown problem"}` }, waiting: false };
  const base = { runId, title: state.workflowName, when: ago(state.endedAt ?? state.createdAt, now) };
  const waiting = waitingDetail(listing, state);
  if (waiting !== null) return { row: { ...base, symbol: SYMBOLS.wait, tone: "warn", detail: `${waiting}${mockNote(state)}` }, waiting: true };
  switch (state.state) {
    case "succeeded":
      return { row: { ...base, symbol: SYMBOLS.ok, tone: "accent", detail: `${succeededDetail(state)}${mockNote(state)}` }, waiting: false };
    case "failed":
      return { row: { ...base, symbol: SYMBOLS.fail, tone: "error", detail: `${failedDetail(state)}${mockNote(state)}` }, waiting: false };
    case "cancelled":
      return { row: { ...base, symbol: SYMBOLS.fail, tone: "muted", detail: `cancelled${mockNote(state)}` }, waiting: false };
    default: {
      const where = listing.lock.state === "held" ? `running now (PID ${listing.lock.owner.pid})` : listing.lock.state === "other_host" ? `running on ${listing.lock.owner.host}` : state.state;
      return { row: { ...base, symbol: SYMBOLS.pending, tone: "muted", detail: `${where}${mockNote(state)}` }, waiting: false };
    }
  }
}

/** The home screen's lists from `listRuns` (newest first), as of `now`. */
export function homeModel(listings: readonly RunListing[], now: number): HomeModel {
  const rows = listings.map((listing) => rowOf(listing, now));
  const recent = rows.filter((entry) => !entry.waiting).map((entry) => entry.row);
  return { waiting: rows.filter((entry) => entry.waiting).map((entry) => entry.row), recent: recent.slice(0, RECENT_SHOWN), older: Math.max(0, recent.length - RECENT_SHOWN) };
}

/** A step's player in the status line: its model if one is requested, else its tool; `mock` for the mock. */
function playerOf(assignment: RoleAssignment): string {
  if (assignment.tool === null) return "mock";
  const who = assignment.model ?? TOOLS.find((tool) => tool.id === assignment.tool)?.name ?? assignment.adapter;
  return assignment.effort ? `${who}·${assignment.effort}` : who;
}

/** The status line of who plays each step by default, e.g. "plan opus·high  implement Codex  review sonnet". */
export function rolesLine(assignments: readonly RoleAssignment[]): string {
  return assignments.map((assignment) => `${assignment.role} ${playerOf(assignment)}`).join("  ");
}

/**
 * The status line with the session's changes for the next run on it. With no usable tool and no mock chosen it says so
 * instead of showing the mock as if it were a choice: a task then offers the mock, once, on its own screen.
 */
export function statusOf(assignments: readonly RoleAssignment[], session: TaskSession): string {
  const changes = sessionChanges(session);
  // What changed comes first: the status is cut at the right, and a change that cannot be seen was not said.
  const next = changes.length > 0 ? `next run: ${changes.join(", ")}  ·  ` : "";
  if (session.mock) return `${next}mock plays every step (scripted, its output is no evidence)`;
  if (assignments.every((assignment) => assignment.tool === null)) return "no coding tool is usable here: a task offers the scripted mock";
  return `${next}${rolesLine(sessionCasting(assignments, session))}`;
}
