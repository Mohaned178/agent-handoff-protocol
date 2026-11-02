// What the run screen shows under the timeline while the run waits for a person, as lines: the work a gate asks to approve
// (the diff from the run's base to the verified commit) and what is known of an attempt whose outcome is unknown. Pure.

import type { AttemptView } from "../protocol/index.ts";
import type { DiffFile } from "./diff-model.ts";
import { diffLine, fileLine, toolCallLines, type Line, type Segment } from "./run-model.ts";

const seg = (text: string, tone: Segment["tone"] = "text", bold?: boolean): Segment => (bold ? { text, tone, bold } : { text, tone });
const line = (key: string, ...segments: Segment[]): Line => ({ key, segments });

/** The diff of the gate's commit, as read: files, or why it could not be. */
export interface ApprovalDiff {
  files: DiffFile[];
  /** True when git's output was cut at the limit, so the last file may be partial. */
  truncated: boolean;
  error: string | null;
}

/** "What you are approving" and its diff. `null` while the diff is being read. */
export function approvalLines(diff: ApprovalDiff | null): Line[] {
  const lines: Line[] = [line("d-head", seg("What you are approving", "text", true), seg("  the diff from the run's base to the commit that was checked", "muted"))];
  if (diff === null) return [...lines, line("d-reading", seg("reading the diff…", "muted"))];
  if (diff.error !== null) return [...lines, line("d-error", seg(`The diff could not be read: ${diff.error}`, "error"))];
  if (diff.files.length === 0) return [...lines, line("d-none", seg("it changes nothing", "muted"))];
  for (const file of diff.files) {
    lines.push(fileLine(file, `d-${file.path}`));
    if (!file.binary && !file.huge) file.lines.forEach((entry, index) => lines.push(diffLine(entry, `d-${file.path}-${index}`)));
  }
  if (diff.truncated) lines.push(line("d-truncated", seg("… the diff goes on; git shows the rest", "muted")));
  return lines;
}

/** How many of the last activity lines the recovery section shows. */
const ACTIVITY_SHOWN = 15;

/**
 * What a person deciding an unknown attempt is told: what it did (its activity log), what its workspace holds now (the diff,
 * when it could be read; else the changed files the report recorded), how the shared refs moved, and what AHP cannot see.
 */
export function recoveryLines(attempt: AttemptView, workspace: DiffFile[] | null): Line[] {
  const report = attempt.recovery?.report ?? null;
  const lines: Line[] = [line("d-head", seg(`What happened to attempt ${attempt.number}`, "text", true), seg("  its outcome is unknown; AHP never runs it again by itself", "muted"))];
  if (attempt.recovery) lines.push(line("d-why", seg(`${attempt.recovery.reason}: ${attempt.recovery.detail}`, "warn")));
  if (report === null) return [...lines, line("d-noreport", seg("no recovery report was recorded", "muted"))];

  lines.push(line("d-did", seg("What it did", "text", true)));
  const entries = report.activity?.entries ?? [];
  const shown = toolCallLines(entries);
  if (report.activity === null) lines.push(line("d-nolog", seg("  its tool wrote no activity log", "muted")));
  else if (shown.length === 0) lines.push(line("d-nothing", seg("  the log holds no tool call or message", "muted")));
  else {
    if (shown.length > ACTIVITY_SHOWN || report.activity.truncated) lines.push(line("d-earlier", seg("  … earlier activity is in the activity log", "muted")));
    for (const item of shown.slice(-ACTIVITY_SHOWN)) lines.push({ key: `d-a${item.line.key}`, segments: [seg("  "), ...item.line.segments] });
  }

  lines.push(line("d-ws", seg("Its workspace", "text", true)));
  if (!report.workspace.exists) lines.push(line("d-ws-gone", seg("  the workspace is gone: there is no result to adopt", "warn")));
  else if (report.workspace.error !== null) lines.push(line("d-ws-error", seg(`  it could not be read: ${report.workspace.error}`, "error")));
  else if (workspace !== null) {
    if (workspace.length === 0) lines.push(line("d-ws-none", seg("  it changed nothing", "muted")));
    for (const file of workspace) {
      lines.push({ key: `d-w${file.path}`, segments: [seg("  "), ...fileLine(file, `d-w${file.path}`).segments] });
      if (!file.binary && !file.huge) file.lines.forEach((entry, index) => lines.push({ key: `d-w${file.path}-${index}`, segments: [seg("  "), ...diffLine(entry, `x-${index}`).segments] }));
    }
  } else if (report.workspace.changed.length === 0) lines.push(line("d-ws-none", seg("  it changed nothing", "muted")));
  else for (const changed of report.workspace.changed) lines.push(line(`d-w${changed.path}`, seg("  ✎ ", "accent"), seg(changed.path, "text"), seg(`  ${changed.change}`, "muted")));

  lines.push(line("d-refs", seg("The shared refs", "text", true)));
  if (report.refs.error !== null) lines.push(line("d-refs-error", seg(`  not compared: ${report.refs.error}`, "warn")));
  else if (report.refs.changed.length === 0) lines.push(line("d-refs-none", seg("  none moved while it ran", "muted")));
  else for (const ref of report.refs.changed) lines.push(line(`d-r${ref.name}`, seg(`  ${ref.name}  ${ref.before?.slice(0, 8) ?? "(new)"} → ${ref.after?.slice(0, 8) ?? "(removed)"}`, "warn")));

  lines.push(line("d-und", seg(report.undetermined, "muted")));
  lines.push(line("d-choices", seg("adopt", "text", true), seg(" checks its workspace as the step's result; ", "muted"), seg("abort", "text", true), seg(" ends the step", "muted")));
  return lines;
}
