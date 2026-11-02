// What `/runs` lists, as data: every run of the repository, newest first, with the state symbol, the workflow's name (the
// slug of the task: the ledger records no more), its age, the outcome and the usage per tool in one line. Usage only as each
// tool reported it, labelled with the tool, never summed across tools or estimated; a tool that reported nothing says so.

import type { RunListing } from "../sdk/run.ts";
import { money, summarizeUsage, type UsageSummary } from "../runtime/usage.ts";
import { rowOf, type HomeRow } from "./screens/home-model.ts";

export interface RunsRow extends HomeRow {
  /** One line, a segment per tool: "codex 12,300 in · 800 out"; "" when no attempt ran. */
  usage: string;
  /** False for a run whose ledger cannot be read: `enter` does not open it. */
  openable: boolean;
}

const thousands = (count: number) => count.toLocaleString("en-US");

/** One tool's segment: its name first, so a cut line never leaves a bare number. */
export function usageSegment(summary: UsageSummary): string {
  const who = summary.adapter;
  if (summary.reported === 0) return `${who} not reported`;
  const counts = [
    ...(summary.counts.inputTokens.attempts > 0 ? [`${thousands(summary.counts.inputTokens.sum)} in`] : []),
    ...(summary.counts.outputTokens.attempts > 0 ? [`${thousands(summary.counts.outputTokens.sum)} out`] : []),
    ...(summary.counts.inputTokens.attempts === 0 && summary.counts.outputTokens.attempts === 0 && summary.counts.totalTokens.attempts > 0 ? [`${thousands(summary.counts.totalTokens.sum)} tokens`] : []),
    ...summary.cost.map((cost) => `${money(cost.amount)} ${cost.currency}`),
  ];
  const partial = summary.reported < summary.attempts ? ` (${summary.reported} of ${summary.attempts} attempts)` : "";
  return `${who} ${counts.length > 0 ? counts.join(" · ") : "reported"}${partial}`;
}

/** The usage line of a run: its tools one after the other, each as that tool reported it. */
export function usageLine(listing: RunListing): string {
  if (!listing.state) return "";
  const attempts = listing.state.steps.flatMap((step) => step.attempts);
  return summarizeUsage(attempts)
    .map(usageSegment)
    .join("  ·  ");
}

/** Every run as a row, in the order given (`listRuns`: newest first). */
export function runsModel(listings: readonly RunListing[], now: number): RunsRow[] {
  return listings.map((listing) => ({ ...rowOf(listing, now).row, usage: usageLine(listing), openable: listing.state !== null }));
}

/** The rows that hold every word of `query` (case-insensitively) in their name, outcome, age, usage or ID; order kept. */
export function filterRuns(rows: readonly RunsRow[], query: string): RunsRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const text = `${row.title} ${row.detail} ${row.when} ${row.usage} ${row.runId}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
