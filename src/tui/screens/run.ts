// The run screen (spec "Run: live coding"): a view over the files the runtime owns. The ledger and the activity logs are
// followed from their last offsets (`follow.ts`), the running attempt's worktree is diffed at most once a second, and
// everything shown is `runModel`'s reading of them. The screen keeps only the selection, what is folded and its scroll.
// What the run waits for a person to decide is decided here with one key (`decision.ts` says what, the runner carries it out
// through the SDK): a gate (a approve, r reject with a reason), an unknown attempt (a adopt, x abort), a run whose process
// stopped (enter resumes it). A refusal is one error line; the ledger is followed as before.

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { decisionOf, type DecisionRequest } from "../../commands/decision.ts";
import type { LockState } from "../../ledger/lock.ts";
import { transcriptPaths } from "../../runtime/paths.ts";
import { pendingApprovalOf } from "../../runtime/index.ts";
import type { RunView } from "../../protocol/index.ts";
import { Frame } from "../components/frame.ts";
import { Prompt } from "../components/prompt.ts";
import { approvalLines, recoveryLines, type ApprovalDiff } from "../decision-model.ts";
import { editPrompt, emptyPrompt, promptActionOf, type PromptState } from "../prompt-model.ts";
import type { ActiveRun } from "../task-runner.ts";
import { Spinner } from "../components/spinner.ts";
import { parseUnifiedDiff, type DiffFile } from "../diff-model.ts";
import { followRun, type FollowedRun } from "../follow.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import { attemptBase, readCommitDiff, readLiveDiff, readTail } from "../live-diff.ts";
import type { Nav } from "../nav.ts";
import { bodyOf, diffLine, fileLine, MARK_SYMBOL, MARK_TONE, runModel, runningAttemptOf, windowStart, wrapLine, type Block, type LiveDiff, type Line, type RunModel, type SidebarSection } from "../run-model.ts";
import { useTheme } from "../theme.ts";

/** The fewest milliseconds between two redraws of the run screen. */
export const REDRAW_MS = 100;
/** The fewest milliseconds between two reads of the live diff. */
export const DIFF_MS = 1_000;
/** The sidebar's width, its border included. */
export const SIDEBAR_COLUMNS = 36;

/** Where the run screen reads from. Tests give their own clock; `pid` is the process whose lock is this screen's own run. */
export interface RunSources {
  repo: string;
  now: () => number;
  pid: number;
  pollMs?: number;
}

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; run: FollowedRun };

/** The run's files, followed while the screen is open, and redrawn at most every `REDRAW_MS`. */
function useFollowedRun(sources: RunSources, runId: string, active: boolean): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    if (!active) return;
    let live = true;
    let follower: Awaited<ReturnType<typeof followRun>> | null = null;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = (run: FollowedRun) => {
      if (!live) return;
      const wait = last + REDRAW_MS - Date.now();
      if (wait <= 0) {
        last = Date.now();
        setLoaded({ state: "ready", run });
        return;
      }
      timer ??= setTimeout(() => {
        timer = null;
        last = Date.now();
        if (live && follower) setLoaded({ state: "ready", run: follower.current() });
      }, wait);
    };
    followRun({ repo: sources.repo, runId, onChange: show, pollMs: sources.pollMs }).then(
      (opened) => {
        if (!live) return opened.close();
        follower = opened;
        show(opened.current());
      },
      (error: unknown) => live && setLoaded({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      follower?.close();
    };
  }, [sources, runId, active]);
  return loaded;
}

/**
 * The running attempt's worktree against the commit it started from: read at most every `DIFF_MS`, only while the
 * attempt runs and the screen is open, and never while the previous read is still going.
 */
function useLiveDiff(run: FollowedRun | null, attemptId: string | null, active: boolean): LiveDiff | null {
  const [diff, setDiff] = useState<LiveDiff | null>(null);
  const target = useMemo(() => {
    if (!run?.state || attemptId === null) return null;
    const attempt = run.state.steps.flatMap((step) => step.attempts).find((candidate) => candidate.id === attemptId);
    const base = attemptBase(run.state, attemptId);
    return attempt && base ? { attemptId, worktree: attempt.workspace, base } : null;
  }, [run?.state, attemptId]);
  useEffect(() => {
    if (!active || target === null) return;
    let live = true;
    let busy = false;
    const seen = new Map<string, number>();
    const read = () => {
      if (busy) return;
      busy = true;
      readLiveDiff(target.worktree, target.base, seen)
        .then((files) => live && setDiff({ attemptId: target.attemptId, files }))
        .catch(() => undefined)
        .finally(() => (busy = false));
    };
    read();
    const timer = setInterval(read, DIFF_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, target?.attemptId, target?.worktree, target?.base]);
  return diff;
}

/** A clock for the elapsed and idle times, ticking each second while the run is live. */
function useNow(now: () => number, ticking: boolean): number {
  const [time, setTime] = useState(now);
  useEffect(() => {
    setTime(now());
    if (!ticking) return;
    const timer = setInterval(() => setTime(now()), 1_000);
    return () => clearInterval(timer);
  }, [now, ticking]);
  return time;
}

function LineView({ line, prefix, selected }: { line: Line; prefix?: string; selected?: boolean }) {
  const theme = useTheme();
  return h(
    Box,
    { height: 1, backgroundColor: selected ? theme.color("surface") : undefined },
    h(
      Text,
      { wrap: "truncate-end" },
      prefix ? h(Text, { color: theme.color("border") }, prefix) : null,
      ...line.segments.map((segment, index) => h(Text, { key: index, color: theme.color(segment.tone), bold: segment.bold && theme.bold }, segment.text)),
    ),
  );
}

function Header({ block, selected, wide }: { block: Block; selected: boolean; wide: boolean }) {
  const theme = useTheme();
  const surface = selected ? theme.color("surface") : undefined;
  const mark = block.mark === "running" ? h(Spinner) : h(Text, { color: theme.color(MARK_TONE[block.mark]) }, MARK_SYMBOL[block.mark]);
  return h(
    Box,
    { height: 1, backgroundColor: surface },
    h(Box, { width: 2, flexShrink: 0 }, mark),
    h(Box, { width: 11, flexShrink: 0 }, h(Text, { color: theme.color("text"), bold: theme.bold && selected, wrap: "truncate-end" }, block.stepId)),
    h(
      Box,
      { width: wide ? 34 : 28, flexShrink: 1, marginRight: 1 },
      h(Text, { wrap: "truncate-end" }, h(Text, { color: theme.color("text") }, block.who), block.reportedModel ? h(Text, { color: theme.color("muted") }, ` (reported ${block.reportedModel})`) : null),
    ),
    h(Box, { width: 8, flexShrink: 0 }, h(Text, { color: theme.color("muted") }, block.time)),
    h(Box, { flexGrow: 1, flexShrink: 1 }, h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, block.tokens)),
  );
}

function Sidebar({ sections, height }: { sections: readonly SidebarSection[]; height: number }) {
  const theme = useTheme();
  const rows: ReturnType<typeof h>[] = [];
  for (const section of sections) {
    if (rows.length > 0) rows.push(h(Text, { key: `${section.key}-gap` }, " "));
    rows.push(h(Text, { key: section.key, color: theme.color("text"), bold: theme.bold, wrap: "truncate-end" }, section.heading));
    for (const line of section.lines) rows.push(h(LineView, { key: `${section.key}-${line.key}`, line, prefix: " " }));
  }
  return h(Box, { flexDirection: "column", height, overflow: "hidden" }, ...rows.slice(0, height));
}

/** A row of the timeline: a block's header, one of its lines, or a line of the receipt. */
type Row = { key: string; block: number | null; header?: Block; line?: Line; prefix?: string };

/** The timeline's rows, `width` columns wide: the receipt's lines wrap rather than lose a fact to "…". */
function timelineRows(model: RunModel, width: number, decision: Line[] | null): Row[] {
  const rows: Row[] = [];
  model.blocks.forEach((block, index) => {
    rows.push({ key: `h-${block.stepId}`, block: index, header: block });
    for (const line of bodyOf(block)) rows.push({ key: `l-${block.stepId}-${line.key}`, block: index, line, prefix: "  │ " });
  });
  // What the person is asked to decide is the timeline's last block.
  if (decision) {
    rows.push({ key: "decision-gap", block: null, line: { key: "gap", segments: [{ text: "", tone: "text" }] } });
    for (const line of decision) for (const row of wrapLine(line, width - 1)) rows.push({ key: `${line.key === "d-head" ? "decision-head" : "x"}-${row.key}`, block: null, line: row, prefix: " " });
  }
  if (model.receipt) {
    rows.push({ key: "receipt-gap", block: null, line: { key: "gap", segments: [{ text: "", tone: "text" }] } });
    rows.push({ key: "receipt-head", block: null, line: { key: "head", segments: [{ text: "Receipt", tone: "text", bold: true }, { text: "  from the run's ledger: an agent's report is a claim, a check decides", tone: "muted" }] } });
    for (const line of model.receipt) for (const row of wrapLine(line, width - 1)) rows.push({ key: `r-${row.key}`, block: null, line: row, prefix: " " });
  }
  return rows;
}

type View = { kind: "timeline" } | { kind: "diff"; title: string; lines: Line[]; offset: number } | { kind: "log"; title: string; lines: string[] | null; offset: number };

export interface RunScreenProps {
  layout: Layout;
  sources: RunSources;
  runId: string;
  nav: Nav;
  active: boolean;
  /** Cancels the run through its signal, when this process runs it (ticket 05); without it, ctrl+c quits. */
  cancel?: () => void;
  /** The run started or continued in this window, going or ended: a decision in progress, and why one was refused. */
  running?: ActiveRun | null;
  /** Carries out a decision in this process; throws when it cannot start. Without it the screen only shows. */
  decide?: (spec: { runId: string; name: string; mock: boolean; request: DecisionRequest }) => void;
}

/** The diff a gate asks to approve, read once from its pinned commit (never a worktree) while the gate is open. */
function useApprovalDiff(state: RunView | null, gateKey: string | null): ApprovalDiff | null {
  const [diff, setDiff] = useState<{ key: string; value: ApprovalDiff } | null>(null);
  useEffect(() => {
    if (state === null || gateKey === null) return;
    let live = true;
    pendingApprovalOf(state).then(
      (pending) => live && setDiff({ key: gateKey, value: { files: pending?.diff ? parseUnifiedDiff(pending.diff) : [], truncated: pending?.diffTruncated ?? false, error: pending?.diffError ?? null } }),
      (error: unknown) => live && setDiff({ key: gateKey, value: { files: [], truncated: false, error: error instanceof Error ? error.message : String(error) } }),
    );
    return () => {
      live = false;
    };
  }, [gateKey]);
  return gateKey !== null && diff?.key === gateKey ? diff.value : null;
}

/** An unknown attempt's workspace against its base, read once (read only); null while reading or when it cannot be read. */
function useWorkspaceDiff(worktree: string | null, base: string | null, key: string | null): DiffFile[] | null {
  const [diff, setDiff] = useState<{ key: string; files: DiffFile[] } | null>(null);
  useEffect(() => {
    if (worktree === null || base === null || key === null) return;
    let live = true;
    readLiveDiff(worktree, base).then(
      (files) => live && setDiff({ key, files }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [key]);
  return key !== null && diff?.key === key ? diff.files : null;
}

const diffViewLines = (files: readonly DiffFile[]): Line[] =>
  files.flatMap((file) => [fileLine(file, `f-${file.path}`), ...(file.binary || file.huge ? [] : file.lines.map((line, index) => diffLine(line, `f-${file.path}-${index}`)))]);

export function RunScreen({ layout, sources, runId, nav, active, cancel, running = null, decide }: RunScreenProps) {
  const theme = useTheme();
  const loaded = useFollowedRun(sources, runId, active);
  const run = loaded.state === "ready" ? loaded.run : null;
  const [selected, setSelected] = useState<string | null>(null);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [usageShown, setUsageShown] = useState(false);
  const [view, setView] = useState<View>({ kind: "timeline" });
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState<{ prompt: PromptState; error: string | null } | null>(null);
  const [offset, setOffset] = useState(0);
  const ended = run?.state?.endedAt != null;
  const now = useNow(sources.now, active && !ended);

  const lock: LockState | null = run?.lock ?? null;
  // A decision going on in this process holds the lock itself; until the screen has read that, it must not offer another.
  const mine = running !== null && running.runId === runId;
  const deciding = mine && running.phase !== "ended";
  const decision = run?.state && !deciding ? decisionOf(run.state, lock) : null;
  const refusal = mine && running.phase === "ended" ? running.error : null;
  const openApproval = decision?.kind === "gate" ? decision.step.approvals.at(-1) : undefined;
  const approvalDiff = useApprovalDiff(run?.state ?? null, decision?.kind === "gate" && openApproval ? `${decision.step.id}:${openApproval.commit}` : null);
  const unknownAttempt = decision?.kind === "unknown" ? decision.attempt : null;
  const workspaceDiff = useWorkspaceDiff(unknownAttempt?.workspace ?? null, unknownAttempt && run?.state ? attemptBase(run.state, unknownAttempt.id) : null, unknownAttempt?.id ?? null);
  const diff = useLiveDiff(run, run?.state ? runningAttemptOf(run.state, lock, sources.pid) : null, active);
  const model = run?.state ? runModel({ events: run.events, state: run.state, activity: run.activity, diff, lastOutput: run.lastOutput, lock }, { now, pid: sources.pid, toggled, decide: decision !== null && decide !== undefined }) : null;

  const selectedIndex = model ? Math.max(0, selected === null ? model.active : model.blocks.findIndex((block) => block.stepId === selected)) : 0;
  const block = model?.blocks[selectedIndex];
  const step = block && run?.state ? run.state.steps.find((candidate) => candidate.id === block.stepId) : undefined;
  const lastAttempt = step?.attempts.at(-1);

  const height = Math.max(1, layout.rows - 3 - (model?.notice ? 1 : 0) - (notice ? 1 : 0) - (refusal ? 1 : 0) - (deciding ? 1 : 0) - (reason ? 5 + (reason.error ? 1 : 0) : 0));
  const scrolls = decide !== undefined && (decision?.kind === "gate" || decision?.kind === "unknown");
  const decisionRows = decision?.kind === "gate" ? approvalLines(approvalDiff) : decision?.kind === "unknown" ? recoveryLines(decision.attempt, workspaceDiff) : null;
  const rows = model ? timelineRows(model, layout.columns - 2 - (layout.wide ? SIDEBAR_COLUMNS : 0), decisionRows) : [];
  const decisionAt = Math.max(0, rows.findIndex((row) => row.key.startsWith("decision-head")));
  const lastStart = Math.max(0, rows.length - height);
  const sidebarBeside = layout.wide;

  // The log view follows the transcript while it is open.
  const logAttempt = view.kind === "log" ? lastAttempt?.id : undefined;
  useEffect(() => {
    if (view.kind !== "log" || !run || !logAttempt) return;
    let live = true;
    void readTail(transcriptPaths(run.location, runId, logAttempt).output).then((lines) => {
      if (!live) return;
      setView((current) => (current.kind === "log" ? { ...current, lines, offset: current.lines === null ? Number.MAX_SAFE_INTEGER : current.offset } : current));
    });
    return () => {
      live = false;
    };
  }, [view.kind, logAttempt, run]);

  const openDiff = () => {
    if (!step || !lastAttempt || !run?.state) return;
    if (diff && diff.attemptId === lastAttempt.id) return setView({ kind: "diff", title: `${step.id}: the code so far (live)`, lines: diffViewLines(diff.files), offset: 0 });
    const from = attemptBase(run.state, lastAttempt.id);
    const to = lastAttempt.snapshot?.commit;
    if (!from || !to) return setNotice(`${step.id} has no diff to show yet.`);
    setNotice(null);
    readCommitDiff(run.location.repo, from, to).then(
      (files) => setView({ kind: "diff", title: `${step.id}: attempt ${lastAttempt.number}'s snapshot`, lines: files.length > 0 ? diffViewLines(files) : [{ key: "none", segments: [{ text: "it changed nothing", tone: "muted" }] }], offset: 0 }),
      (error: unknown) => setNotice(`The diff could not be read: ${error instanceof Error ? error.message : String(error)}`),
    );
  };

  const move = (by: number) => {
    if (!model || model.blocks.length === 0) return;
    const next = Math.max(0, Math.min(model.blocks.length - 1, selectedIndex + by));
    setSelected(model.blocks[next]!.stepId);
  };
  const toggle = () => {
    if (!block) return;
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(block.stepId)) next.delete(block.stepId);
      else next.add(block.stepId);
      return next;
    });
  };
  const scrollDecision = (by: number) => setOffset((current) => Math.max(-decisionAt, Math.min(lastStart - decisionAt, Math.min(current, lastStart - decisionAt) + by)));
  const request = (what: DecisionRequest) => {
    if (!run?.state || !decide) return;
    setNotice(null);
    try {
      decide({ runId, name: run.state.workflowName, mock: run.state.mock, request: what });
    } catch (error) {
      setNotice(error instanceof Error ? error.message.split("\n")[0]! : String(error));
      return;
    }
    setOffset(0);
  };
  const submitReason = () => {
    if (!reason || decision?.kind !== "gate") return;
    const text = reason.prompt.value.trim();
    if (text === "") return setReason({ ...reason, error: "a reason is needed: the agent is given it" });
    setReason(null);
    request({ type: "reject", stepId: decision.step.id, reason: text });
  };
  const scroll = (by: number) =>
    setView((current) => {
      if (current.kind === "timeline") return current;
      const total = current.kind === "diff" ? current.lines.length : (current.lines?.length ?? 0);
      const bottom = Math.max(0, total - height);
      return { ...current, offset: Math.max(0, Math.min(bottom, Math.min(current.offset, bottom) + by)) };
    });

  const live = model?.live === true && !ended;
  const quitOrCancel: KeyBinding =
    cancel && live
      ? { keys: "ctrl+c", label: "cancel", match: is.ctrl("c"), run: cancel }
      : { keys: "ctrl+c", label: "quit", match: is.ctrl("c"), run: nav.quit };
  const canDiff = Boolean(lastAttempt && ((diff && diff.attemptId === lastAttempt.id) || lastAttempt.snapshot));
  const stopped = decide !== undefined && decision?.kind === "stopped";
  const keys: KeyBinding[] =
    reason !== null
      ? [
          { keys: "enter", label: "reject", match: is.enter, run: submitReason },
          { keys: "esc", label: "back", match: is.escape, run: () => setReason(null) },
          quitOrCancel,
        ]
      : view.kind === "timeline"
        ? [
          { keys: "a", label: "approve", when: scrolls && decision?.kind === "gate", match: is.char("a"), run: () => decision?.kind === "gate" && request({ type: "approve", stepId: decision.step.id }) },
          { keys: "r", label: "reject", when: scrolls && decision?.kind === "gate", match: is.char("r"), run: () => setReason({ prompt: emptyPrompt(), error: null }) },
          { keys: "a", label: "adopt", when: scrolls && decision?.kind === "unknown", match: is.char("a"), run: () => decision?.kind === "unknown" && request({ type: "adopt", attemptId: decision.attempt.id }) },
          { keys: "x", label: "abort", when: scrolls && decision?.kind === "unknown", match: is.char("x"), run: () => decision?.kind === "unknown" && request({ type: "abort", attemptId: decision.attempt.id }) },
          { keys: "enter", label: "resume", when: stopped, match: is.enter, run: () => request({ type: "resume" }) },
          { keys: "↑↓", label: "scroll", when: scrolls, match: is.upOrDown, run: (_, key) => scrollDecision(key.upArrow ? -1 : 1) },
          { keys: "↑↓", label: "step", when: !scrolls && (model?.blocks.length ?? 0) > 1, match: is.upOrDown, run: (_, key) => move(key.upArrow ? -1 : 1) },
          { keys: "enter", label: block?.expanded ? "fold" : "expand", when: block !== undefined && !stopped && !scrolls, match: is.enter, run: toggle },
          { keys: "d", label: "full diff", when: canDiff && !scrolls, match: is.char("d"), run: openDiff },
          { keys: "l", label: "raw log", when: lastAttempt !== undefined && !scrolls, match: is.char("l"), run: () => setView({ kind: "log", title: `${step!.id}: attempt ${lastAttempt!.number}'s raw output`, lines: null, offset: 0 }) },
          { keys: "u", label: usageShown ? "timeline" : "usage", when: !sidebarBeside, match: is.char("u"), run: () => setUsageShown((shown) => !shown) },
          { keys: "esc", label: "back", match: is.escape, run: nav.back },
          { keys: "?", label: "help", match: is.char("?"), run: () => nav.open("help"), footer: false },
          quitOrCancel,
        ]
      : [
          { keys: "↑↓", label: "scroll", match: is.upOrDown, run: (_, key) => scroll(key.upArrow ? -1 : 1) },
          { keys: "pgup pgdn", label: "page", match: (_, key) => key.pageUp || key.pageDown, run: (_, key) => scroll(key.pageUp ? -height : height) },
          { keys: "esc", label: "timeline", match: is.escape, run: () => setView({ kind: "timeline" }) },
          quitOrCancel,
        ];
  useInput(
    (input, key) => {
      if (dispatch(keys, input, key) || reason === null) return;
      const action = promptActionOf(input, key);
      if (action) setReason({ prompt: editPrompt(reason.prompt, action).state, error: null });
    },
    { isActive: active },
  );
  usePaste((text) => reason && setReason({ prompt: editPrompt(reason.prompt, { type: "insert", text }).state, error: null }), { isActive: active && reason !== null });

  const title = model?.title ?? `run ${runId}`;
  const body: ReturnType<typeof h>[] = [];
  if (model?.notice) body.push(h(LineView, { key: "notice", line: model.notice }));
  if (notice) body.push(h(Text, { key: "screen-notice", color: theme.color("error"), wrap: "truncate-end" }, notice));
  if (refusal) body.push(h(Text, { key: "refusal", color: theme.color("error"), wrap: "truncate-end" }, refusal));
  if (deciding) body.push(h(Spinner, { key: "deciding", label: "going on with the run…" }));
  if (run?.problem) body.push(h(Text, { key: "problem", color: theme.color("error"), wrap: "truncate-end" }, run.problem));

  if (loaded.state === "loading") body.push(h(Spinner, { key: "loading", label: "reading the run" }));
  else if (loaded.state === "failed") body.push(h(Text, { key: "failed", color: theme.color("error"), wrap: "wrap" }, `The run could not be opened: ${loaded.message}`));
  else if (!model) body.push(h(Text, { key: "empty", color: theme.color("muted") }, "The run's ledger has nothing in it yet."));
  else if (view.kind === "diff" || view.kind === "log") {
    const lines: Line[] = view.kind === "diff" ? view.lines : (view.lines ?? []).map((text, index) => ({ key: String(index), segments: [{ text, tone: "text" }] }));
    const bottom = Math.max(0, lines.length - (height - 1));
    const offset = Math.min(view.offset, bottom);
    body.push(h(Text, { key: "view-title", color: theme.color("accent"), wrap: "truncate-end" }, `${view.title}${lines.length > height - 1 ? `  (${offset + 1}–${Math.min(lines.length, offset + height - 1)} of ${lines.length})` : ""}`));
    if (view.kind === "log" && view.lines === null) body.push(h(Spinner, { key: "reading", label: "reading the transcript" }));
    else if (view.kind === "log" && view.lines!.length === 0) body.push(h(Text, { key: "nothing", color: theme.color("muted") }, "nothing printed yet"));
    for (const line of lines.slice(offset, offset + height - 1)) body.push(h(LineView, { key: `v-${line.key}`, line }));
  } else {
    // The frame's padding, and the sidebar beside the timeline.
    const from = rows.findIndex((row) => row.block === selectedIndex);
    let to = from;
    while (to + 1 < rows.length && rows[to + 1]!.block === selectedIndex) to += 1;
    // With nothing selected beyond the last block (the run ended), the receipt stays in view.
    // A decision to make is in view from its heading; the person scrolls from there.
    const start = scrolls
      ? Math.max(0, Math.min(lastStart, decisionAt + offset))
      : ended && selectedIndex === model.active && selected === null
        ? Math.max(0, rows.length - height)
        : windowStart(rows.length, height, Math.max(0, from), Math.max(0, to));
    const timeline = h(
      Box,
      { key: "timeline", flexDirection: "column", flexGrow: 1, flexShrink: 1, overflow: "hidden" },
      ...rows.slice(start, start + height).map((row) =>
        row.header ? h(Header, { key: row.key, block: row.header, selected: row.block === selectedIndex, wide: layout.wide }) : h(LineView, { key: row.key, line: row.line!, prefix: row.prefix }),
      ),
    );
    const sidebar = h(
      Box,
      { key: "sidebar", width: sidebarBeside ? SIDEBAR_COLUMNS : undefined, flexGrow: sidebarBeside ? 0 : 1, flexShrink: 0, borderStyle: sidebarBeside ? "single" : undefined, borderTop: false, borderBottom: false, borderRight: false, borderColor: theme.color("border"), borderBackgroundColor: theme.color("bg"), paddingLeft: 1 },
      h(Sidebar, { sections: model.sidebar, height }),
    );
    if (sidebarBeside) body.push(h(Box, { key: "panes", flexDirection: "row", flexGrow: 1 }, timeline, sidebar));
    else body.push(usageShown ? sidebar : timeline);
    if (reason) {
      body.push(h(Text, { key: "reason-ask", color: theme.color("warn") }, "Why reject? The agent is given this with the step sent back."));
      if (reason.error) body.push(h(Text, { key: "reason-error", color: theme.color("error") }, reason.error));
      body.push(h(Prompt, { key: "reason", state: reason.prompt, placeholder: "what to change", focused: true }));
    }
  }

  return h(Frame, { layout, title, right: ended ? undefined : model?.live ? "live" : undefined, keys }, ...body);
}
