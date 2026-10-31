// What `ahp run` shows in a terminal: one line per step, a spinner on the step at work with what its agent is doing,
// and only what a person needs to read kept on screen (a step's result, what it changed, why it failed or was sent
// back). The steps still to come are listed below it and redrawn in place. Everything is derived from the ledger's
// events and the state replayed after them, as the plain log is; `--verbose`, a pipe or CI print that log instead.

import { THIS_REPOSITORY, type LedgerEvent, type RunView, type StepView } from "../protocol/index.ts";
import { TOOLS } from "../doctor/index.ts";
import type { Prompter } from "../setup/index.ts";
import { describeStop, formatEvent } from "./format.ts";
import { failureLineOf } from "./receipt.ts";
import { span } from "./progress.ts";

/** The terminal ahp writes to, when stdout is one. */
export interface Terminal {
  /** Writes raw text, with no newline added. */
  write: (text: string) => void;
  columns: () => number;
  color: boolean;
  /** Show the compact view (false with --verbose: the whole log, as when piped). */
  compact: boolean;
  /** Asks a person, when stdin is a terminal too; null otherwise. */
  prompter: Prompter | null;
}

/** Text to print once the git it needs has been read; null prints nothing. */
export type Output = string | null | (() => Promise<string | null>);

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CODES = { green: "\u001b[32m", red: "\u001b[31m", yellow: "\u001b[33m", cyan: "\u001b[36m", dim: "\u001b[2m", bold: "\u001b[1m", reset: "\u001b[0m" };
type Paint = keyof typeof CODES;

const FAILURE_WORDS: Record<string, string> = {
  verification_failed: "check failed",
  agent_error: "agent error",
  transient: "temporary error",
  config_auth: "login or configuration problem",
};

export interface LiveViewOptions {
  repo: string;
  /** The files an attempt's snapshot changed, as one line (`describeChanges`), or null when they cannot be read. */
  changesOf: (commit: string) => Promise<string | null>;
  /** False when the view goes on from one already on screen (after a decision at a gate): no heading again. */
  heading?: boolean;
  now?: () => number;
}

export class LiveView {
  private readonly term: Terminal;
  private readonly options: LiveViewOptions;
  private readonly now: () => number;
  private readonly began: number;
  private state: Readonly<RunView> | null = null;
  /** Steps whose result is on screen: they leave the redrawn list. */
  private readonly done = new Set<string>();
  /** When each step became ready in this process. */
  private readonly startedAt = new Map<string, number>();
  private readonly phase = new Map<string, string>();
  private drawn = 0;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(term: Terminal, options: LiveViewOptions) {
    this.term = term;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.began = this.now();
  }

  /** What to print for an event; the list below is redrawn on its own. */
  onEvent(event: LedgerEvent, state: Readonly<RunView>): Output[] {
    const first = this.state === null;
    this.state = state;
    const out: Output[] = first ? this.opening(state) : [];
    if (first && this.timer === null) {
      this.timer = setInterval(() => {
        this.frame += 1;
        this.redraw();
      }, 100);
      this.timer.unref();
    }
    switch (event.type) {
      case "step_ready":
        this.done.delete(event.stepId);
        this.startedAt.set(event.stepId, this.now());
        this.phase.set(event.stepId, "starting");
        break;
      case "attempt_created":
      case "attempt_running": {
        const step = this.stepOfAttempt(event.attemptId);
        const attempt = step?.attempts.find((a) => a.id === event.attemptId);
        if (step && attempt) this.phase.set(step.id, `${attempt.number > 1 ? `attempt ${attempt.number} · ` : ""}${event.type === "attempt_running" ? "working" : "starting"}`);
        break;
      }
      case "verification_started": {
        const step = this.stepOfAttempt(event.attemptId);
        if (step) this.phase.set(step.id, event.command === null ? "checking the report" : `checking: ${event.command}`);
        break;
      }
      case "external_action_intended":
        this.phase.set(event.stepId, event.target.kind === "push_branch" ? `pushing ${event.target.branch}` : event.target.kind === "open_pr" ? "opening a pull request" : "merging the pull request");
        break;
      case "retry_scheduled": {
        const step = state.steps.find((s) => s.id === event.stepId);
        const attempt = step?.attempts.find((a) => a.id === event.attemptId);
        this.phase.set(event.stepId, "trying again");
        // One line: why, in a word, and the line of its output that says what failed; the rest is `ahp inspect`'s.
        const why = FAILURE_WORDS[event.failureClass] ?? event.failureClass;
        const detail = attempt ? failureLineOf(attempt) : null;
        out.push(this.fit(this.line("yellow", "↻", event.stepId, `${why}${detail ? `: ${detail}` : ""} · trying again`)));
        break;
      }
      case "step_sent_back": {
        const step = this.stepOfAttempt(event.attemptId);
        const attempt = step?.attempts.find((a) => a.id === event.attemptId);
        const findings = attempt?.sentBack?.kind === "review" ? attempt.sentBack.findings : [];
        out.push(this.fit(this.line("yellow", "↩", event.reviewStepId, `asked for changes${findings.length > 0 ? `: ${findings.join("; ")}` : ""}`)));
        break;
      }
      case "approval_sent_back": {
        const step = this.stepOfAttempt(event.attemptId);
        out.push(this.line("yellow", "↩", event.gateStepId, `rejected; ${step?.id ?? "the step before it"} goes back with your reason`));
        break;
      }
      case "step_terminal":
        out.push(this.finished(event.stepId, state));
        break;
      case "run_terminal":
        out.push(this.ending(state));
        break;
      case "run_resumed":
        if (event.takenOverFrom) out.push(this.paint("yellow", `! ${formatEvent(event, state)}`));
        break;
      case "attempt_unknown": {
        const step = this.stepOfAttempt(event.attemptId);
        const attempt = step?.attempts.find((a) => a.id === event.attemptId);
        out.push(this.fit(this.paint("yellow", `! ${step?.id ?? "?"}: attempt ${attempt?.number ?? "?"}'s outcome is unknown (${event.reason}); it is never retried automatically`)));
        break;
      }
      // Its report and the commands are `ahp inspect`'s and the run's "next" line.
      case "recovery_report_written":
      case "recovery_awaited":
        break;
      // What needs a person, or is rare enough that the plain line says it best.
      case "handoff_rejected":
      case "recovery_decided":
      case "ledger_truncated":
      case "run_cancel_requested":
      case "attempt_cancelling":
      case "external_action_failed":
        out.push(this.paint("yellow", `! ${formatEvent(event, state)}`));
        break;
      default:
        break;
    }
    return out;
  }

  /** What an agent is doing now, from the progress watcher. */
  activity(stepId: string, text: string): void {
    if (this.done.has(stepId)) return;
    const attempt = this.state?.steps.find((s) => s.id === stepId)?.attempts.at(-1);
    this.phase.set(stepId, `${attempt && attempt.number > 1 ? `attempt ${attempt.number} · ` : ""}${text}`);
    this.redraw();
  }

  /** The heading of an approval request, with what it would approve when that could be read. */
  approvalHeading(changes: string | null = null): string {
    return `${this.paint("bold", `${this.paint("cyan", "?")} waiting for your approval`)}${changes ? `: ${changes}` : ""}`;
  }

  /** Prints `text` above the redrawn list. */
  say(text: string, print: (text: string) => void): void {
    this.clear();
    print(text);
    this.draw();
  }

  /** Stops redrawing and leaves the screen with the printed lines only. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }

  private opening(state: Readonly<RunView>): Output[] {
    if (this.options.heading === false) {
      for (const step of state.steps) if (step.state === "succeeded") this.done.add(step.id);
      return [];
    }
    const lines = [`${this.paint("bold", `ahp · ${state.workflowName}`)} ${this.paint("dim", `· ${this.options.repo} · ${state.runId}`)}`, ""];
    // A run picked up by this process: what it had already done.
    for (const step of state.steps) {
      if (step.state !== "succeeded") continue;
      this.done.add(step.id);
      lines.push(this.line("green", "✓", step.id, this.who(step)));
    }
    return [lines.join("\n")];
  }

  private finished(stepId: string, state: Readonly<RunView>): Output {
    const step = state.steps.find((s) => s.id === stepId);
    if (!step) return null;
    this.done.add(stepId);
    const took = this.startedAt.has(stepId) ? span(this.now() - this.startedAt.get(stepId)!) : "";
    const last = step.attempts.at(-1);
    const verdict = step.kind === "review" && step.state === "succeeded" ? last?.reportedOutput.verdict : undefined;
    const label = [this.who(step), took, typeof verdict === "string" ? verdict.replace("_", " ") : ""].filter(Boolean).join(" · ");
    if (step.state === "failed") {
      // Why it stopped, and the line of the last failure that says what went wrong: the rest is `ahp inspect`'s.
      const stop = describeStop(step, state)?.split("\n")[0]?.trim() ?? "";
      const why = last ? failureLineOf(last) : null;
      return [this.line("red", "✗", stepId, label), ...this.details([[stop, why].filter(Boolean).join(": ")].filter(Boolean).map((line) => this.fitText(line, 6)), "red")].join("\n");
    }
    if (step.state !== "succeeded") return this.line("dim", "○", stepId, `${step.state}${label ? ` · ${label}` : ""}`);
    const commit = last?.snapshot?.commit;
    const heading = this.line("green", "✓", stepId, label);
    // A review's snapshot is the work it read: what changed is said once, by the step that changed it.
    if (!commit || step.kind === "review") return heading;
    return async () => {
      const changes = await this.options.changesOf(commit).catch(() => null);
      return changes && changes !== "changed nothing" ? [heading, ...this.details([changes], "dim")].join("\n") : heading;
    };
  }

  private ending(state: Readonly<RunView>): string {
    // A view that went on after a decision at a gate began after the run did: the run's own start says how long it took.
    const since = this.options.heading === false ? Date.parse(state.createdAt) : this.began;
    const took = span(this.now() - since);
    if (state.state === "succeeded") return `\n${this.paint("green", "✓")} ${this.paint("bold", `run succeeded in ${took}`)}`;
    if (state.state === "cancelled") return `\n${this.paint("dim", `○ run cancelled after ${took}`)}`;
    return `\n${this.paint("red", "✗")} ${this.paint("bold", `run ${state.state.replace("_", " ")}`)}`;
  }

  /** Who did a step: the tool and the model asked for; for a gate who decided it, for an action what it did. */
  private who(step: StepView): string {
    if (step.kind === "approval_gate") {
      const decision = step.approvals.at(-1)?.decision;
      return decision ? `${decision.decision} by ${decision.user}` : "";
    }
    if (step.kind === "external_action") {
      const target = step.action?.target;
      if (!target || step.state !== "succeeded") return "";
      const already = step.action?.performed === null;
      if (target.kind === "push_branch" && target.remote === THIS_REPOSITORY) return `${already ? "branch already here:" : "made branch"} ${target.branch}`;
      if (target.kind === "push_branch") return already ? `${target.branch} was already on ${target.remote}` : `pushed ${target.branch} to ${target.remote}`;
      return target.kind === "open_pr" ? "pull request open" : "pull request merged";
    }
    const attempt = step.attempts.at(-1);
    if (!attempt) return "";
    const tool = attempt.mock ? "mock" : (TOOLS.find((t) => t.adapter === attempt.adapter)?.name ?? attempt.adapter);
    return attempt.requestedModel ? `${tool} (${attempt.requestedModel})` : tool;
  }

  private stepOfAttempt(attemptId: string): StepView | undefined {
    return this.state?.steps.find((s) => s.attempts.some((a) => a.id === attemptId));
  }

  private get width(): number {
    return Math.max(...(this.state?.steps.map((s) => s.id.length) ?? [0]), 7) + 3;
  }

  private line(color: Paint, symbol: string, stepId: string, text: string): string {
    return `  ${this.paint(color, symbol)} ${stepId.padEnd(this.width)}${text}`.trimEnd();
  }

  /** `text` cut to the terminal's width at `indent` columns in, with "…" where it was cut; never wrapped. */
  private fitText(text: string, indent: number): string {
    const room = Math.max(this.term.columns(), 20) - 1 - indent;
    return text.length > room ? `${text.slice(0, room - 1)}…` : text;
  }

  /** A printed line cut to the terminal's width, its colour codes kept out of the count. */
  private fit(line: string): string {
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
    const room = Math.max(this.term.columns(), 20) - 1;
    return plain.length > room ? `${plain.slice(0, room - 1)}…` : line;
  }

  private details(lines: readonly string[], color: Paint): string[] {
    return lines.map((l) => `      ${this.paint(color, l)}`);
  }

  private paint(color: Paint, text: string): string {
    return this.term.color ? `${CODES[color]}${text}${CODES.reset}` : text;
  }

  /** The steps not yet on screen: the one at work with a spinner, those to come dimmed. */
  private region(): string[] {
    if (!this.state || this.timer === null) return [];
    const columns = Math.max(this.term.columns(), 20) - 1;
    const fit = (text: string) => (text.length > columns ? `${text.slice(0, columns - 1)}…` : text);
    return this.state.steps
      .filter((step) => !this.done.has(step.id))
      .map((step) => {
        const since = this.startedAt.get(step.id);
        if (since === undefined) return this.paint("dim", fit(`  · ${step.id}`));
        const parts = [this.who(step), span(this.now() - since), this.phase.get(step.id) ?? ""].filter(Boolean).join("   ");
        const text = fit(`  ${SPINNER[this.frame % SPINNER.length]} ${step.id.padEnd(this.width)}${parts}`);
        return `  ${this.paint("cyan", text.slice(2, 3))}${text.slice(3)}`;
      });
  }

  private clear(): void {
    if (this.drawn === 0) return;
    this.term.write(`\r${this.drawn > 1 ? `\u001b[${this.drawn - 1}A` : ""}\u001b[0J`);
    this.drawn = 0;
  }

  private draw(): void {
    const lines = this.region();
    if (lines.length === 0) return;
    this.term.write(lines.join("\n"));
    this.drawn = lines.length;
  }

  private redraw(): void {
    this.clear();
    this.draw();
  }
}
