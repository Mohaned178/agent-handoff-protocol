// The run screen as data (spec "Run: live coding"): from what the runtime's files hold (the ledger's events and their
// replay, each attempt's activity log, the running attempt's live diff) the timeline's blocks, the sidebar and the
// receipt. Pure: the screen keeps only which block is selected and which are folded, and renders this.
//
// Honest numbers: usage only as each tool reported it, per tool, never summed across tools or estimated; "not reported"
// where a tool said nothing. An agent "reported done"; only a passing check "verified".

import { checkCommandOf, endedWhy, failureLineOf, MOCK_RECEIPT_LINE, receiptOf } from "../commands/receipt.ts";
import { TOOLS } from "../doctor/tools.ts";
import type { LockState } from "../ledger/lock.ts";
import {
  isAgentStep,
  isApprovalGate,
  isExternalAction,
  reviewFindingsOf,
  reviewVerdictOf,
  THIS_REPOSITORY,
  UNKNOWN_MODEL,
  type ActivityEntry,
  type AgentRef,
  type AttemptView,
  type LedgerEvent,
  type RunView,
  type StepView,
  type UsageReport,
  type WorkflowDefinition,
  type WorkflowStepDefinition,
} from "../protocol/index.ts";
import { resolveRetryPolicy } from "../runtime/failure.ts";
import { resolveTimeout } from "../runtime/timeout.ts";
import { money, sourcesText, summarizeUsage, type UsageSummary } from "../runtime/usage.ts";
import type { DiffFile, DiffLine } from "./diff-model.ts";
import { SYMBOLS, type Token } from "./theme.ts";

// ---------------------------------------------------------------------------
// What the model reads and what it gives.

/** What the screen has read of a run's files. */
export interface RunFiles {
  /** The ledger's checked events, in order. */
  events: readonly LedgerEvent[];
  /** Their replay. */
  state: RunView;
  /** Each attempt's activity log entries, oldest first, by attempt ID; an attempt with no log is absent. */
  activity: Readonly<Record<string, readonly ActivityEntry[]>>;
  /** The running attempt's worktree against its base, as last read; null when none was read. */
  diff: LiveDiff | null;
  /** When each attempt's raw output last grew (ms since the epoch), by attempt ID: its idle time runs from there. */
  lastOutput: Readonly<Record<string, number>>;
  /** The run's ledger lock as last read; null before it was. */
  lock: LockState | null;
}

export interface LiveDiff {
  attemptId: string;
  files: DiffFile[];
}

export interface RunModelOptions {
  now: number;
  /** Blocks (by step ID) folded or unfolded by the person, against their default. */
  toggled?: ReadonlySet<string>;
  /** This process's PID: a lock it holds is this screen's own run. */
  pid?: number;
  /** How many activity lines a block shows, newest last; older ones are counted. */
  maxActivity?: number;
  /** True when the screen offers the person a key for what the run waits for: the lines that name the `ahp` command to run are left out. */
  decide?: boolean;
}

/** A piece of a line in one colour. */
export interface Segment {
  text: string;
  tone: Token;
  bold?: boolean;
}

export interface Line {
  key: string;
  segments: Segment[];
}

/** A step's mark: ✓ ✗ ↻ ! ○, or the spinner while it runs. */
export type Mark = "ok" | "fail" | "cancelled" | "running" | "retry" | "wait" | "pending";

export const MARK_SYMBOL: Readonly<Record<Exclude<Mark, "running">, string>> = {
  ok: SYMBOLS.ok,
  fail: SYMBOLS.fail,
  cancelled: SYMBOLS.fail,
  retry: SYMBOLS.retry,
  wait: SYMBOLS.wait,
  pending: SYMBOLS.pending,
};

export const MARK_TONE: Readonly<Record<Mark, Token>> = { ok: "accent", fail: "error", cancelled: "muted", running: "accent", retry: "warn", wait: "warn", pending: "muted" };

export interface Block {
  stepId: string;
  mark: Mark;
  /** The tool · model · effort, or for a gate where the approved work goes. */
  who: string;
  /** The model the tool reported, when it differs from the one requested. */
  reportedModel: string | null;
  /** How long the step has taken so far, or took. */
  time: string;
  /** The step's tokens as its tool reported them so far; empty when it reported none. */
  tokens: string;
  /** Shown while the block is expanded. */
  lines: Line[];
  /** Shown while it is folded: its retries and send-backs, one line each. */
  folded: Line[];
  expanded: boolean;
}

export interface SidebarSection {
  key: string;
  heading: string;
  lines: Line[];
}

export interface RunModel {
  /** The title line after "AHP": the run, its workflow, how long it has taken, and "mock" on the mock. */
  title: string;
  /** About the process writing the run: another one, or none (it stopped partway); null for this screen's own run. */
  notice: Line | null;
  /** True while a process is writing the run, so its marks may move. */
  live: boolean;
  blocks: Block[];
  /** The index of the block at work, or the one that ended the run; the default selection. */
  active: number;
  sidebar: SidebarSection[];
  /** Once the run has ended: what the checks found, usage per tool, the next command. */
  receipt: Line[] | null;
  /** The running attempt the live diff and the raw log are for, when one runs. */
  runningAttempt: string | null;
}

// ---------------------------------------------------------------------------
// Small words.

/** A duration: "14s", "1m12s", "1h3m". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`;
}

/** A count for reading: 13300 → "13.3k". */
export const thousands = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

const toolName = (adapter: string) => (adapter === "mock" ? "mock" : (TOOLS.find((tool) => tool.adapter === adapter)?.name ?? adapter));

const seg = (text: string, tone: Token = "text", bold?: boolean): Segment => (bold ? { text, tone, bold } : { text, tone });
const line = (key: string, ...segments: Segment[]): Line => ({ key, segments });
const firstLine = (text: string) => text.split(/\r?\n/)[0] ?? "";
const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, " ").trim();

// ---------------------------------------------------------------------------
// When things happened, from the events.

interface Times {
  attempts: Map<string, { created: number; running: number | null; exited: number | null }>;
  /** The last `step_terminal` of each step. */
  ended: Map<string, number>;
  /** The first `approval_requested` of each gate. */
  requested: Map<string, number>;
}

function timesOf(events: readonly LedgerEvent[]): Times {
  const times: Times = { attempts: new Map(), ended: new Map(), requested: new Map() };
  for (const event of events) {
    const at = Date.parse(event.time);
    switch (event.type) {
      case "attempt_created":
        times.attempts.set(event.attemptId, { created: at, running: null, exited: null });
        break;
      case "attempt_running": {
        const attempt = times.attempts.get(event.attemptId);
        if (attempt) attempt.running = at;
        break;
      }
      case "attempt_exited":
      case "attempt_unknown": {
        const attempt = times.attempts.get(event.attemptId);
        if (attempt && attempt.exited === null) attempt.exited = at;
        break;
      }
      case "step_terminal":
        times.ended.set(event.stepId, at);
        break;
      case "approval_requested":
        if (!times.requested.has(event.stepId)) times.requested.set(event.stepId, at);
        break;
    }
  }
  return times;
}

const workflowOf = (events: readonly LedgerEvent[]): WorkflowDefinition | null => {
  const created = events[0];
  return created?.type === "run_created" ? created.workflow : null;
};

// ---------------------------------------------------------------------------
// Who plays a step.

/** The agent an attempt ran: the step's own, or its reroute when the attempt ran on that one's adapter. */
function agentOf(definition: WorkflowStepDefinition | undefined, attempt: AttemptView | undefined): AgentRef | null {
  if (!definition || !isAgentStep(definition)) return null;
  if (attempt && definition.reroute && attempt.adapter === definition.reroute.adapter && attempt.adapter !== definition.agent.adapter) return definition.reroute;
  return definition.agent;
}

const effortOf = (agent: AgentRef | null): string | null => {
  const effort = (agent?.options as { effort?: unknown } | undefined)?.effort;
  return typeof effort === "string" && effort !== "" ? effort : null;
};

function whoOf(definition: WorkflowStepDefinition | undefined, step: StepView): { who: string; reportedModel: string | null } {
  const last = step.attempts.at(-1);
  const agent = agentOf(definition, last);
  if (!agent) return { who: "", reportedModel: null };
  const adapter = last?.adapter ?? agent.adapter;
  const requested = last ? last.requestedModel : (agent.model ?? null);
  const effort = effortOf(agent);
  const who = [toolName(adapter), requested ?? "default model", ...(effort ? [effort] : [])].join(" · ");
  const reported = last && last.reportedModel !== UNKNOWN_MODEL && last.reportedModel !== requested ? last.reportedModel : null;
  return { who, reportedModel: reported };
}

/** Where a gate's approved work goes: the external actions after it. */
function destinationsAfter(workflow: WorkflowDefinition | null, index: number): string {
  const steps = workflow?.steps ?? [];
  const actions: string[] = [];
  for (let i = index + 1; i < steps.length && isExternalAction(steps[i]!); i++) {
    const action = (steps[i] as Extract<WorkflowStepDefinition, { action: unknown }>).action;
    const remote = action.remote ?? "origin";
    if (action.kind === "push_branch") actions.push(remote === THIS_REPOSITORY ? `branch ${action.branch}` : `branch ${action.branch} on ${remote}`);
    else if (action.kind === "open_pr") actions.push(`pull request ${action.branch} → ${action.base}`);
    else actions.push(`merge ${action.branch}`);
  }
  return actions.length > 0 ? `→ ${actions.join(", ")}` : "";
}

// ---------------------------------------------------------------------------
// Usage, as reported.

/** The latest usage an attempt's tool reported for the whole attempt so far: the ledger's once it exited, else its log's. */
function usageSoFar(attempt: AttemptView, activity: readonly ActivityEntry[] | undefined): UsageReport | null {
  if (attempt.state === "exited" || attempt.state === "unknown") return attempt.usage;
  for (let i = (activity?.length ?? 0) - 1; i >= 0; i--) {
    const entry = activity![i]!;
    if (entry.type === "usage" && entry.scope === "attempt") return entry.usage;
  }
  return null;
}

const lastMessageUsage = (activity: readonly ActivityEntry[] | undefined): UsageReport | null => {
  for (let i = (activity?.length ?? 0) - 1; i >= 0; i--) {
    const entry = activity![i]!;
    if (entry.type === "usage" && entry.scope === "message") return entry.usage;
  }
  return null;
};

function tokensText(summary: UsageSummary | undefined): string {
  if (!summary || summary.reported === 0) return "";
  const parts = [
    ...(summary.counts.inputTokens.attempts > 0 ? [`${thousands(summary.counts.inputTokens.sum)} in`] : []),
    ...(summary.counts.outputTokens.attempts > 0 ? [`${thousands(summary.counts.outputTokens.sum)} out`] : []),
    ...(summary.counts.inputTokens.attempts === 0 && summary.counts.outputTokens.attempts === 0 && summary.counts.totalTokens.attempts > 0 ? [`${thousands(summary.counts.totalTokens.sum)} tokens`] : []),
    ...summary.cost.map((cost) => `${money(cost.amount)} ${cost.currency}`),
  ];
  return parts.join(" · ");
}

/** A step's tokens so far: its attempts on the tool of its last attempt, summed as that tool reported them. */
function stepTokens(step: StepView, files: RunFiles): string {
  const last = step.attempts.at(-1);
  if (!last) return "";
  const same = step.attempts.filter((attempt) => attempt.adapter === last.adapter);
  return tokensText(summarizeUsage(same.map((attempt) => ({ adapter: attempt.adapter, usage: usageSoFar(attempt, files.activity[attempt.id]) })))[0]);
}

// ---------------------------------------------------------------------------
// A step's mark.

const isActive = (step: StepView) => step.state === "ready" || step.state === "in_progress" || step.state === "verifying";

function markOf(step: StepView, live: boolean): Mark {
  switch (step.state) {
    case "succeeded":
      return "ok";
    case "failed":
      return "fail";
    case "cancelled":
      return "cancelled";
    case "waiting_approval":
    case "needs_recovery":
      return "wait";
    case "blocked":
      return "pending";
    default:
      if (!live) return "wait";
      return step.state === "ready" && step.attempts.at(-1)?.retry ? "retry" : "running";
  }
}

// ---------------------------------------------------------------------------
// Activity lines.

const RUNS_A_COMMAND = /exec|bash|shell|command|terminal/i;
/** `cd "<…>/att_…" && ` at the start of a command: into an attempt's worktree, whose path ends in its attempt ID. */
const INTO_WORKTREE = /^cd\s+(?:"[^"]*[\\/]att_[a-z0-9]+[\\/]?"|'[^']*[\\/]att_[a-z0-9]+[\\/]?'|\S*[\\/]att_[a-z0-9]+[\\/]?)\s*(?:&&|;)\s*/i;

export function toolCallLines(entries: readonly ActivityEntry[]): { at: number; line: Line }[] {
  // One line per call, where it first appeared, in the state the tool last reported.
  const calls = new Map<string, { at: number; index: number; entry: Extract<ActivityEntry, { type: "tool_call" }>; permission: "allowed" | "rejected" | null }>();
  const out: { at: number; index: number; line: Line | null; id?: string }[] = [];
  entries.forEach((entry, index) => {
    if (entry.type === "tool_call") {
      const known = calls.get(entry.toolCallId);
      if (known) {
        known.entry = { ...entry, kind: entry.kind ?? known.entry.kind, title: entry.title ?? known.entry.title, paths: entry.paths.length > 0 ? entry.paths : known.entry.paths };
        if (entry.permission) known.permission = entry.permission;
        return;
      }
      calls.set(entry.toolCallId, { at: Date.parse(entry.time), index, entry, permission: entry.permission });
      out.push({ at: Date.parse(entry.time), index, line: null, id: entry.toolCallId });
    } else if (entry.type === "message") {
      out.push({ at: Date.parse(entry.time), index, line: line(`m${index}`, seg(`"${oneLine(entry.text)}"`, "text")) });
    }
  });
  return out.map((item) => {
    if (item.line) return { at: item.at, line: item.line };
    const call = calls.get(item.id!)!;
    const { entry } = call;
    const command = RUNS_A_COMMAND.test(entry.kind ?? "");
    const said = oneLine(entry.title ?? entry.kind ?? "tool call");
    // A command that first goes into the attempt's own worktree: the `cd` is the long part and says nothing (ticket 10).
    const title = command ? said.replace(INTO_WORKTREE, "") : said;
    const path = entry.paths[0];
    // Windows tools title a path with backslashes; the path itself has slashes, and is not said twice.
    const label = path && !title.replaceAll("\\", "/").includes(path) ?`${title} ${path}${entry.paths.length > 1 ? ` +${entry.paths.length - 1}` : ""}` : title;
    const segments = [seg(command ? "$ " : "● ", command ? "accent" : "muted"), seg(label, entry.status === "completed" ? "text" : "muted")];
    if (entry.status === "failed") segments.push(seg("  ✗ failed", "error"));
    if (call.permission === "rejected") segments.push(seg("  refused by AHP", "warn"));
    return { at: item.at, line: line(`c${entry.toolCallId}`, ...segments) };
  });
}

/** How many lines of the newest changed file the live diff shows. */
export const NEWEST_FILE_LINES = 30;

/** A changed file in one line: `✎ path +3 −1`, or named as binary or too large. */
export function fileLine(file: DiffFile, key: string): Line {
  const segments = [seg("✎ ", "accent"), seg(file.path, "text")];
  if (file.binary) segments.push(seg("  binary, not shown", "muted"));
  else if (file.added === null) segments.push(seg("  too large to show", "muted"));
  else {
    segments.push(seg(`  +${file.added}`, "added"), seg(` −${file.removed}`, "removed"));
    if (file.huge) segments.push(seg("  too large to show", "muted"));
  }
  if (file.change !== "modified") segments.push(seg(`  ${file.change}`, "muted"));
  return line(key, ...segments);
}

/** One line of a diff: its number, its sign, its text, coloured as added or removed. */
export function diffLine(diff: DiffLine, key: string): Line {
  if (diff.sign === "@") return line(key, seg(`  ⋯ ${diff.text}`.trimEnd(), "muted"));
  const number = diff.number === null ? "" : String(diff.number);
  const sign = diff.sign === "+" ? "+" : diff.sign === "-" ? "−" : " ";
  const tone: Token = diff.sign === "+" ? "added" : diff.sign === "-" ? "removed" : "muted";
  return line(key, seg(`  ${number.padStart(4)} ${sign} `, diff.sign === " " ? "muted" : tone), seg(diff.text, diff.sign === " " ? "text" : tone));
}

/** The live diff's lines, oldest change first: each file one line, the newest expanded. */
function diffLines(files: readonly DiffFile[]): { at: number; line: Line }[] {
  const ordered = [...files].sort((a, b) => (a.changedAt ?? 0) - (b.changedAt ?? 0) || (a.path < b.path ? -1 : 1));
  const newest = ordered.at(-1);
  return ordered.flatMap((file) => {
    const at = file.changedAt ?? 0;
    const head = { at, line: fileLine(file, `f${file.path}`) };
    if (file !== newest || file.binary || file.huge) return [head];
    const shown = file.lines.slice(0, NEWEST_FILE_LINES).map((diff, index) => ({ at, line: diffLine(diff, `f${file.path}:${index}`) }));
    const more = file.lines.length > NEWEST_FILE_LINES ? [{ at, line: line(`f${file.path}:more`, seg(`  … ${file.lines.length - NEWEST_FILE_LINES} more lines: d shows the whole diff`, "muted")) }] : [];
    return [head, ...shown, ...more];
  });
}

// ---------------------------------------------------------------------------
// Retries, send-backs, outcomes.

const FAILURE_WORDS: Record<string, string> = {
  rejected: "its handoff was refused",
  config_auth: "a login, usage limit or configuration problem",
  transient: "a temporary error",
  agent_error: "the agent failed",
  verification_failed: "its check failed",
  inconclusive: "its check could not run",
  unknown: "its outcome is unknown",
};

const whyOf = (attempt: AttemptView) => failureLineOf(attempt) ?? (attempt.failureClass ? FAILURE_WORDS[attempt.failureClass] ?? attempt.failureClass : "it failed");

/** The tail of a failed check's output, for a retry line opened with enter. */
function failingOutput(attempt: AttemptView): string[] {
  const output = attempt.verification?.evidence.find((item) => item.kind === "test_output" && item.exitCode !== 0);
  if (!output || output.kind !== "test_output") return [];
  return output.output.split(/\r?\n/).map((text) => text.trimEnd()).filter(Boolean).slice(-12);
}

/** The lines about an attempt that ended and was followed by another: why, and what the next one is. */
function retryLines(step: StepView, budget: { budget: number; transientBudget: number }): { folded: Line[]; detail: Map<string, Line[]> } {
  const folded: Line[] = [];
  const detail = new Map<string, Line[]>();
  let retries = 0;
  let transient = 0;
  step.attempts.forEach((attempt, index) => {
    const retry = attempt.retry;
    if (!retry) return;
    const next = step.attempts[index + 1];
    const key = `r${attempt.id}`;
    const sent = attempt.sentBack;
    if (retry.change === "reroute") {
      retries = 0;
      transient = 0;
      folded.push(line(key, seg(`${SYMBOLS.retry} `, "warn"), seg(`attempt ${attempt.number}: ${whyOf(attempt)}; its budget is spent, so ${next ? toolName(next.adapter) : "the alternative agent"} takes the step over`, "warn")));
    } else if (sent) {
      retries += 1;
      const what = sent.kind === "review" ? `sent back by ${sent.reviewStepId}: ${firstLine(sent.findings[0] ?? "")}` : `rejected at ${sent.gateStepId} by ${sent.user}: ${firstLine(sent.reason)}`;
      folded.push(line(key, seg(`${SYMBOLS.retry} `, "warn"), seg(`${what} (retry ${retries} of ${budget.budget})`, "warn")));
      const reasons = sent.kind === "review" ? sent.findings : sent.reason.split(/\r?\n/);
      detail.set(key, reasons.map((text, i) => line(`${key}:${i}`, seg(`    | ${text}`, "muted"))));
    } else if (attempt.failureClass === "transient") {
      transient += 1;
      folded.push(line(key, seg(`${SYMBOLS.retry} `, "warn"), seg(`attempt ${attempt.number}: ${whyOf(attempt)}, retrying after ${duration(retry.delayMs)} (transient retry ${transient} of ${budget.transientBudget})`, "warn")));
    } else {
      retries += 1;
      folded.push(line(key, seg(`${SYMBOLS.retry} `, "warn"), seg(`attempt ${attempt.number}: ${whyOf(attempt)}, retrying (retry ${retries} of ${budget.budget})`, "warn")));
      const output = failingOutput(attempt);
      if (output.length > 0) detail.set(key, output.map((text, i) => line(`${key}:${i}`, seg(`    ${text}`, "muted"))));
    }
  });
  return { folded, detail };
}

/** What became of an attempt: reported done and verified, being checked, failed, unknown. */
function outcomeLines(step: StepView, attempt: AttemptView, decide: boolean): Line[] {
  const key = `o${attempt.id}`;
  if (attempt.state === "unknown") {
    const lines = [line(key, seg(`${SYMBOLS.wait} `, "warn"), seg(`outcome unknown: ${oneLine(attempt.recovery?.detail ?? "")}`, "warn"))];
    if (attempt.recovery?.awaited && attempt.recovery.decision === null) {
      if (!decide) lines.push(line(`${key}:next`, seg(`  decide: ahp recover ${attempt.id} --policy adopt|abort`, "muted")));
    } else if (attempt.recovery?.decision) lines.push(line(`${key}:next`, seg(`  decided: ${attempt.recovery.decision.policy}`, "muted")));
    return lines;
  }
  if (attempt.state === "exited" && attempt.outcome === "cancelled") return [line(key, seg(`${SYMBOLS.fail} `, "muted"), seg("cancelled", "muted"))];
  if (attempt.state !== "exited") {
    if (attempt.cancellation) return [line(key, seg("  stopping the agent…", "muted"))];
    return [];
  }
  const verification = attempt.verification;
  if (attempt.outcome === "error" || attempt.error) {
    if (attempt.retry) return [];
    return [line(key, seg(`${SYMBOLS.fail} `, "error"), seg(whyOf(attempt), "error"))];
  }
  const command = verification?.command ?? checkCommandOf(step);
  if (!verification || verification.state === "pending") {
    return [line(key, seg("reported done", "text"), seg(command ? ` · checking \`${command}\` in a clean copy…` : " · checking its output…", "muted"))];
  }
  if (verification.state === "pass") {
    const verdict = step.kind === "review" ? reviewVerdictOf(attempt.reportedOutput) : null;
    const what = command ? `verified: \`${command}\` passed in a clean copy` : "verified: its output is complete (a structural check, not of its quality)";
    const segments = [seg(`${SYMBOLS.ok} `, "accent"), seg("reported done · ", "text"), seg(what, "accent")];
    if (verdict) segments.push(seg(` · verdict: ${verdict === "approved" ? "approved" : "changes requested"}`, "text"));
    // What the review found, under its verdict: after a rejection at a gate it is the review's answer (ticket 10).
    const findings = step.kind === "review" ? reviewFindingsOf(attempt.reportedOutput) : [];
    return [line(key, ...segments), ...findings.map((finding, i) => line(`${key}:f${i}`, seg(`    | ${oneLine(finding)}`, "muted")))];
  }
  if (attempt.retry) return [];
  return [line(key, seg(`${SYMBOLS.fail} `, "error"), seg("reported done · ", "text"), seg(`not verified: ${whyOf(attempt)}`, "error"))];
}

// ---------------------------------------------------------------------------
// Blocks.

function agentBlock(step: StepView, index: number, files: RunFiles, context: BlockContext): Omit<Block, "expanded"> {
  const definition = context.workflow?.steps[index];
  const { who, reportedModel } = whoOf(definition, step);
  const policy = resolveRetryPolicy(definition && isAgentStep(definition) ? definition.retry : undefined);
  const { folded, detail } = retryLines(step, policy);
  const last = step.attempts.at(-1);
  const lines: Line[] = [];
  for (const retry of folded) lines.push(retry, ...(detail.get(retry.key) ?? []));
  if (last) {
    const entries = files.activity[last.id] ?? [];
    const timed = toolCallLines(entries);
    const running = last.state === "running" || last.state === "dispatching";
    if (running && files.diff?.attemptId === last.id) timed.push(...diffLines(files.diff.files));
    timed.sort((a, b) => a.at - b.at);
    const max = context.maxActivity;
    if (timed.length > max) lines.push(line(`more${last.id}`, seg(`… ${timed.length - max} earlier lines: l shows the raw log`, "muted")));
    for (const item of timed.slice(-max)) lines.push(item.line);
    if (running && entries.length === 0 && timed.length === 0) lines.push(line(`wait${last.id}`, seg(last.state === "dispatching" ? "starting the agent…" : "working; nothing reported yet", "muted")));
    lines.push(...outcomeLines(step, last, context.decide));
  } else if (step.state === "ready" || step.state === "in_progress") {
    lines.push(line(`h${step.id}`, seg("handing over…", "muted")));
  }
  for (const refusal of step.handoffs.flatMap((handoff) => (handoff.rejection ?? []).map((reason) => ({ revision: handoff.revision, reason })))) {
    lines.push(line(`x${step.id}${refusal.revision}${refusal.reason.code}`, seg(`${SYMBOLS.fail} `, "error"), seg(`its handoff was refused (revision ${refusal.revision}): ${refusal.reason.message}`, "error")));
  }
  const started = step.attempts[0] ? context.times.attempts.get(step.attempts[0].id)?.created : undefined;
  const ended = isActive(step) ? context.now : (context.times.ended.get(step.id) ?? (last ? context.times.attempts.get(last.id)?.exited : undefined));
  // Folded after a retry or a send-back, a step that then passed says so: a retry line alone reads as still failing,
  // and a step sent back from a gate would hide its answer to the person (ticket 10).
  const answered = folded.length > 0 && last?.verification?.state === "pass" ? outcomeLines(step, last, context.decide) : [];
  return {
    stepId: step.id,
    mark: markOf(step, context.live),
    who,
    reportedModel,
    time: started === undefined ? "" : duration((ended ?? context.now) - started),
    tokens: stepTokens(step, files),
    lines,
    folded: [...folded, ...answered],
  };
}

function gateBlock(step: StepView, index: number, context: BlockContext): Omit<Block, "expanded"> {
  const lines: Line[] = [];
  step.approvals.forEach((approval, n) => {
    const key = `a${step.id}${n}`;
    if (approval.decision === null) {
      lines.push(line(key, seg(`${SYMBOLS.wait} `, "warn"), seg(`waiting for your approval: ${approval.changed.length}${approval.truncated ? "+" : ""} changed ${approval.changed.length === 1 ? "file" : "files"}`, "warn")));
      for (const changed of approval.changed.slice(0, 10)) lines.push(line(`${key}:${changed.path}`, seg("  ✎ ", "accent"), seg(changed.path, "text"), seg(`  ${changed.change}`, "muted")));
      if (approval.changed.length > 10) lines.push(line(`${key}:more`, seg(`  … ${approval.changed.length - 10} more`, "muted")));
      if (!context.decide) lines.push(line(`${key}:how`, seg(`  decide: ahp approve ${context.runId} ${step.id}, or ahp reject ${context.runId} ${step.id} --reason <text>`, "muted")));
    } else if (approval.decision.decision === "approved") {
      lines.push(line(key, seg(`${SYMBOLS.ok} `, "accent"), seg(`approved by ${approval.decision.user}`, "text")));
    } else {
      lines.push(line(key, seg(`${SYMBOLS.fail} `, "error"), seg(`rejected by ${approval.decision.user}: ${firstLine(approval.decision.reason ?? "")}`, "text")));
    }
  });
  // The external actions after the gate are AHP's own, so they are told on the gate's block.
  const steps = context.state.steps;
  for (let i = index + 1; i < steps.length && steps[i]!.kind === "external_action"; i++) {
    const action = steps[i]!;
    const key = `e${action.id}`;
    if (action.action?.failure) lines.push(line(key, seg(`${SYMBOLS.fail} `, "error"), seg(`${action.id}: ${firstLine(action.action.failure.error)}`, "error")));
    else if (action.state === "succeeded") lines.push(line(key, seg(`${SYMBOLS.ok} `, "accent"), seg(`${action.id}: done by AHP`, "text")));
    else if (action.state === "in_progress") lines.push(line(key, seg(`${action.id}: under way…`, "muted")));
    else if (action.state === "cancelled") lines.push(line(key, seg(`${SYMBOLS.fail} `, "muted"), seg(`${action.id}: cancelled`, "muted")));
  }
  const requested = context.times.requested.get(step.id);
  const ended = step.state === "waiting_approval" ? context.now : context.times.ended.get(step.id);
  let mark = markOf(step, context.live);
  const actions: StepView[] = [];
  for (let i = index + 1; i < steps.length && steps[i]!.kind === "external_action"; i++) actions.push(steps[i]!);
  if (mark === "ok" && actions.some((action) => action.state === "failed")) mark = "fail";
  if (mark === "ok" && actions.some((action) => action.state === "in_progress" || action.state === "ready")) mark = context.live ? "running" : "wait";
  return {
    stepId: step.id,
    mark,
    who: destinationsAfter(context.workflow, index),
    reportedModel: null,
    time: requested === undefined ? "" : duration((ended ?? context.now) - requested),
    tokens: "",
    lines,
    folded: [],
  };
}

interface BlockContext {
  runId: string;
  state: RunView;
  workflow: WorkflowDefinition | null;
  times: Times;
  now: number;
  live: boolean;
  maxActivity: number;
  decide: boolean;
}

// ---------------------------------------------------------------------------
// The sidebar.

const notReported = (label: string): Segment[] => [seg(`${label} `, "muted"), seg("not reported", "muted")];

function countSegments(label: string, count: { sum: number; attempts: number }): Segment[] {
  return count.attempts > 0 ? [seg(`${label} `, "muted"), seg(thousands(count.sum), "text")] : notReported(label);
}

const WINDOW_WORDS: Record<string, string> = { five_hour: "5-hour window", seven_day: "7-day window", seven_day_opus: "7-day window (Opus)", seven_day_sonnet: "7-day window (Sonnet)" };

/** A limit as its tool reported it: "plan limit: allowed, 5-hour window", "context 13.3k / 200k". */
export function limitText(entry: Extract<ActivityEntry, { type: "limit" }>): string {
  if (entry.kind === "plan_limit") {
    const window = entry.window === undefined ? null : (WINDOW_WORDS[entry.window] ?? `${entry.window.replaceAll("_", " ")} window`);
    return `plan limit: ${[entry.status ?? "status not reported", ...(window ? [window] : [])].join(", ")}`;
  }
  const used = entry.used === undefined ? "?" : thousands(entry.used);
  const size = entry.size === undefined ? "?" : thousands(entry.size);
  return `context ${used} / ${size}`;
}

function usageSection(adapter: string, attempts: readonly AttemptView[], files: RunFiles): SidebarSection {
  const summary = summarizeUsage(attempts.map((attempt) => ({ adapter, usage: usageSoFar(attempt, files.activity[attempt.id]) })))[0]!;
  const running = attempts.find((attempt) => attempt.state === "running" || attempt.state === "dispatching");
  const lines: Line[] = [];
  const key = `u${adapter}`;
  if (summary.reported === 0) {
    lines.push(line(`${key}:none`, seg(running ? "reported at the end of its turn" : "not reported", "muted")));
  } else {
    const cost = summary.cost.length > 0 ? [seg("cost ", "muted"), seg(summary.cost.map((entry) => `${money(entry.amount)} ${entry.currency}`).join(", "), "text")] : notReported("cost");
    lines.push(
      line(`${key}:io`, ...countSegments("in", summary.counts.inputTokens), seg(" · ", "muted"), ...countSegments("out", summary.counts.outputTokens)),
      line(`${key}:cached`, ...countSegments("cached", summary.counts.cachedInputTokens)),
      line(`${key}:cost`, ...cost),
    );
    if (summary.reported < summary.attempts) lines.push(line(`${key}:of`, seg(`${summary.reported} of ${summary.attempts} attempts reported`, "muted")));
    lines.push(line(`${key}:src`, seg(`source: ${sourcesText(summary.sources)}`, "muted")));
  }
  if (running) {
    const message = lastMessageUsage(files.activity[running.id]);
    if (message && summary.reported === 0) {
      const parts = [message.inputTokens === null ? null : `${thousands(message.inputTokens)} in`, message.outputTokens === null ? null : `${thousands(message.outputTokens)} out`].filter(Boolean);
      if (parts.length > 0) lines.push(line(`${key}:msg`, seg(`last message: ${parts.join(" · ")}`, "muted")));
    }
  }
  // The limits it reported, the latest of each kind, from its newest attempt that reported one.
  const latest = new Map<string, Extract<ActivityEntry, { type: "limit" }>>();
  for (const attempt of attempts) {
    for (const entry of files.activity[attempt.id] ?? []) if (entry.type === "limit") latest.set(entry.kind, entry);
  }
  for (const entry of latest.values()) lines.push(line(`${key}:${entry.kind}`, seg(limitText(entry), "text")));
  return { key, heading: adapter === "mock" ? "mock (scripted, not evidence)" : toolName(adapter), lines };
}

function limitsSection(state: RunView, workflow: WorkflowDefinition | null, focus: number, files: RunFiles, times: Times, now: number): SidebarSection | null {
  const step = state.steps[focus];
  const definition = workflow?.steps[focus];
  if (!step || !definition || !isAgentStep(definition)) return null;
  const lines: Line[] = [];
  const last = step.attempts.at(-1);
  const timeout = resolveTimeout(definition.timeout);
  const limit = (ms: number) => (ms === 0 ? "no limit" : duration(ms));
  if (last && (last.state === "running" || last.state === "dispatching")) {
    const at = times.attempts.get(last.id);
    const since = at?.running ?? at?.created ?? now;
    const output = Math.max(files.lastOutput[last.id] ?? 0, since);
    lines.push(line("l:total", seg("attempt ", "muted"), seg(`${duration(now - since)}/${limit(timeout.totalMs)}`, "text")));
    lines.push(line("l:idle", seg("idle ", "muted"), seg(`${duration(now - output)}/${limit(timeout.idleMs)}`, "text")));
  } else {
    lines.push(line("l:none", seg(`attempt limits ${limit(timeout.totalMs)}, idle ${limit(timeout.idleMs)}`, "muted")));
  }
  const policy = resolveRetryPolicy(definition.retry);
  lines.push(line("l:retries", seg("retries ", "muted"), seg(`${step.retryUsage.retries}/${policy.budget}`, step.retryUsage.retries > 0 ? "warn" : "text")));
  if (step.retryUsage.transientRetries > 0) lines.push(line("l:transient", seg("transient ", "muted"), seg(`${step.retryUsage.transientRetries}/${policy.transientBudget}`, "warn")));
  if (step.retryUsage.rerouted) lines.push(line("l:reroute", seg("rerouted to its alternative agent", "warn")));
  return { key: "limits", heading: `Limits (AHP) · ${step.id}`, lines };
}

// ---------------------------------------------------------------------------
// The receipt.

function receiptLines(state: RunView): Line[] {
  const receipt = receiptOf(state);
  const lines: Line[] = [];
  if (!receipt.checked) lines.push(line("rc:none", seg(`${SYMBOLS.wait} `, "warn"), seg("not verified: no check command", "warn")));
  for (const step of receipt.steps) {
    const key = `rc:${step.stepId}`;
    if (step.verdict === "verified") lines.push(line(key, seg(`${SYMBOLS.ok} `, "accent"), seg(`${step.stepId}: verified: \`${step.command}\` passed in a clean copy`, "text")));
    else if (step.verdict === "not_verified") lines.push(line(key, seg(`${SYMBOLS.fail} `, "error"), seg(`${step.stepId}: not verified: \`${step.command}\` failed`, "text")));
    else if (step.verdict === "ended_before_check") lines.push(line(key, seg(`${SYMBOLS.fail} `, "error"), seg(`${step.stepId}: not verified: the step ended before \`${step.command}\` ran: ${endedWhy(step)}`, "text")));
    if (step.reportedDone.length > 0) {
      const n = step.reportedDone.length;
      const times = n === 1 ? "once" : `${n} times`;
      const when = step.passedAfter ? "before its check passed" : "and its check never passed";
      lines.push(line(`${key}:done`, seg(`  the agent reported done ${times} ${when}; first: attempt ${step.reportedDone[0]!.attempt}: ${step.reportedDone[0]!.why}`, "muted")));
    }
    for (const sent of step.sendBacks) {
      const by = sent.kind === "review" ? `sent back by ${sent.by}` : `rejected at ${sent.by} by ${sent.user}`;
      lines.push(line(`${key}:sent${sent.attempt}`, seg(`  ${by} (attempt ${sent.attempt}): ${sent.after}`, "muted")));
    }
    for (const done of step.reportedDone.filter((item) => item.refused)) {
      lines.push(line(`${key}:refused${done.attempt}`, seg(`${SYMBOLS.wait} `, "warn"), seg(`${step.stepId}: attempt ${done.attempt} ${done.why}`, "warn")));
    }
    for (const refusal of step.handoffRefusals) {
      lines.push(line(`${key}:handoff${refusal.revision}${refusal.message.length}`, seg(`${SYMBOLS.wait} `, "warn"), seg(`${step.stepId}: refused: its handoff (revision ${refusal.revision}): ${refusal.message}`, "warn")));
    }
  }
  for (const summary of receipt.usage) {
    const key = `rc:u:${summary.adapter}`;
    const who = toolName(summary.adapter);
    if (summary.reported === 0) lines.push(line(key, seg("usage ", "muted"), seg(`${who}: none reported`, "muted")));
    else {
      const partial = summary.reported < summary.attempts ? `, ${summary.reported} of ${summary.attempts} attempts` : "";
      lines.push(line(key, seg("usage ", "muted"), seg(`${who}: ${tokensText(summary) || "reported"}`, "text"), seg(` (as reported${partial}; ${sourcesText(summary.sources)})`, "muted")));
    }
  }
  if (receipt.next) lines.push(line("rc:next", seg("next ", "muted"), seg(receipt.next, "accent")));
  if (receipt.mock) lines.push(line("rc:mock", seg(MOCK_RECEIPT_LINE, "warn")));
  return lines;
}

// ---------------------------------------------------------------------------
// The whole screen.

/** Who is writing the run, as this screen can tell from the lock: null when it is this screen's own process, or it ended. */
function noticeOf(state: RunView, lock: LockState | null, pid: number | undefined, decide = false): { notice: Line | null; live: boolean } {
  if (state.endedAt !== null) return { notice: null, live: false };
  const waiting = state.state === "waiting_approval" || state.state === "needs_recovery";
  if (lock?.state === "held") {
    if (lock.owner.pid === pid) return { notice: null, live: true };
    return { notice: line("notice", seg(`run ${state.runId} is running in another terminal (PID ${lock.owner.pid}); this screen only watches it`, "muted")), live: true };
  }
  if (lock?.state === "other_host") return { notice: line("notice", seg(`run ${state.runId} is running on ${lock.owner.host}; this screen only watches it`, "muted")), live: true };
  if (waiting) return { notice: null, live: false };
  if (lock === null) return { notice: null, live: true };
  return { notice: line("notice", seg(`${SYMBOLS.wait} `, "warn"), seg(decide ? "its process stopped partway: enter resumes it" : `its process stopped partway: ahp recover ${state.runId} resumes it`, "warn")), live: false };
}

/** The attempt whose worktree the live diff reads: one running while a process writes the run; null otherwise. */
export function runningAttemptOf(state: RunView, lock: LockState | null, pid?: number): string | null {
  if (!noticeOf(state, lock, pid).live) return null;
  return state.steps.flatMap((step) => step.attempts).find((attempt) => attempt.state === "running" || attempt.state === "dispatching")?.id ?? null;
}

export function runModel(files: RunFiles, options: RunModelOptions): RunModel {
  const { state, events } = files;
  const workflow = workflowOf(events);
  const times = timesOf(events);
  const { notice, live } = noticeOf(state, files.lock, options.pid, options.decide === true);
  const context: BlockContext = { runId: state.runId, state, workflow, times, now: options.now, live, maxActivity: options.maxActivity ?? 60, decide: options.decide === true };

  const shown = state.steps.map((step, index) => ({ step, index })).filter(({ step }) => step.kind !== "external_action");
  const partial = shown.map(({ step, index }) => (step.kind === "approval_gate" || (workflow && isApprovalGate(workflow.steps[index]!)) ? gateBlock(step, index, context) : agentBlock(step, index, files, context)));

  // The block at work: the one running or waiting, else the one that ended the run, else the last that did anything.
  let active = partial.findIndex((block) => block.mark === "running" || block.mark === "retry" || block.mark === "wait");
  if (active === -1) active = partial.findIndex((block) => block.mark === "fail" || block.mark === "cancelled");
  if (active === -1) active = Math.max(0, partial.map((block) => block.mark !== "pending").lastIndexOf(true));
  const blocks: Block[] = partial.map((block, index) => {
    // What is at work is open; so is what failed, waits or was cancelled, which is what a person looks for.
    const byDefault = (index === active && state.endedAt === null) || block.mark === "fail" || block.mark === "wait" || block.mark === "cancelled";
    return { ...block, expanded: options.toggled?.has(block.stepId) ? !byDefault : byDefault };
  });

  // Each tool in the order it first played.
  const attempts = state.steps.flatMap((step) => step.attempts);
  const adapters = [...new Set(attempts.map((attempt) => attempt.adapter))];
  const sidebar: SidebarSection[] = adapters.map((adapter) => usageSection(adapter, attempts.filter((attempt) => attempt.adapter === adapter), files));
  if (adapters.length === 0) sidebar.push({ key: "u:none", heading: "Usage", lines: [line("u:none", seg("no attempt yet", "muted"))] });
  const focus = shown[active] ? shown[active]!.index : 0;
  const limits = limitsSection(state, workflow, focus, files, times, options.now);
  if (limits) sidebar.push(limits);

  const elapsed = duration((state.endedAt ? Date.parse(state.endedAt) : options.now) - Date.parse(state.createdAt));
  return {
    title: [`run ${state.runId}`, state.workflowName, elapsed, ...(state.mock ? ["mock"] : [])].join(" · "),
    notice,
    live,
    blocks,
    active,
    sidebar,
    receipt: state.endedAt === null ? null : receiptLines(state),
    runningAttempt: runningAttemptOf(state, files.lock, options.pid),
  };
}

/**
 * A line broken into rows of at most `width` characters, at spaces where it can, each row after the first indented by
 * `indent`: for the receipt, whose facts are not cut short.
 */
export function wrapLine(source: Line, width: number, indent = "    "): Line[] {
  const chars = source.segments.flatMap((segment) => [...segment.text].map((char) => ({ char, segment })));
  if (chars.length <= width || width <= indent.length + 1) return [source];
  const rows: { char: string; segment: Segment }[][] = [];
  let rest = chars;
  let room = width;
  while (rest.length > room) {
    let cut = room;
    for (let i = room; i > room / 2; i--) {
      if (rest[i]?.char === " ") {
        cut = i;
        break;
      }
    }
    rows.push(rest.slice(0, cut));
    rest = rest.slice(cut).filter((_, index, all) => !(index === 0 && all[0]!.char === " "));
    room = width - indent.length;
  }
  rows.push(rest);
  return rows.map((row, index) => {
    const segments: Segment[] = index === 0 ? [] : [seg(indent, "text")];
    let from: Segment | null = null;
    for (const { char, segment } of row) {
      // Consecutive characters of the same source segment stay one segment.
      if (from === segment) segments.at(-1)!.text += char;
      else segments.push({ ...segment, text: char });
      from = segment;
    }
    return { key: `${source.key}~${index}`, segments };
  });
}

/** The lines of a block as the timeline shows them now: expanded, its body; folded, its retries. */
export const bodyOf = (block: Block): Line[] => (block.expanded ? block.lines : block.folded);

/**
 * The first row to show of `total` rows in a pane `height` rows tall, so that rows `from` to `to` (the selected block)
 * are in view: as near the bottom as they allow, so a block at work shows its newest lines.
 */
export function windowStart(total: number, height: number, from: number, to: number): number {
  if (total <= height) return 0;
  const bottom = total - height;
  // The block's header at the top, or lower still while that leaves the rows below in view; a block taller than the
  // pane shows its last rows, where its newest work is.
  let start = Math.min(bottom, from);
  if (to >= start + height) start = to - height + 1;
  return Math.max(0, Math.min(bottom, start));
}
