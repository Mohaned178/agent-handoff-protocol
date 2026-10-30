// Usage summed per adapter, as the tools reported it: what a run's end and an evaluation's report both show. Never
// estimated, never summed across adapters (their units differ: one counts cached input inside its input tokens, another
// outside), and each number summed only over the attempts that reported it.

import type { UsageReport } from "../protocol/index.ts";

/** The token counts a tool may report; each is summed only over the attempts that reported it, and says how many did. */
export const USAGE_COUNTS = ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"] as const;
export type UsageCount = (typeof USAGE_COUNTS)[number];

/** What the attempts on one adapter reported using, as reported. */
export interface UsageSummary {
  adapter: string;
  attempts: number;
  /** Of those, the attempts that reported any usage. */
  reported: number;
  /** The sources the numbers came from, in the adapter's words. */
  sources: string[];
  counts: Record<UsageCount, { sum: number; attempts: number }>;
  /** Per currency, as reported. */
  cost: { currency: string; amount: number; attempts: number }[];
}

/** One summary per adapter, sorted by adapter name; an attempt with no usage counts in `attempts` and nowhere else. */
export function summarizeUsage(attempts: readonly { adapter: string; usage: UsageReport | null }[]): UsageSummary[] {
  const byAdapter = new Map<string, UsageSummary>();
  for (const { adapter, usage } of attempts) {
    let summary = byAdapter.get(adapter);
    if (!summary) {
      const counts = Object.fromEntries(USAGE_COUNTS.map((count) => [count, { sum: 0, attempts: 0 }])) as UsageSummary["counts"];
      summary = { adapter, attempts: 0, reported: 0, sources: [], counts, cost: [] };
      byAdapter.set(adapter, summary);
    }
    summary.attempts += 1;
    if (!usage) continue;
    summary.reported += 1;
    if (!summary.sources.includes(usage.source)) summary.sources.push(usage.source);
    for (const count of USAGE_COUNTS) {
      const value = usage[count];
      if (value === null) continue;
      summary.counts[count].sum += value;
      summary.counts[count].attempts += 1;
    }
    if (usage.cost) {
      const cost = summary.cost.find((entry) => entry.currency === usage.cost!.currency);
      if (cost) {
        cost.amount += usage.cost.amount;
        cost.attempts += 1;
      } else summary.cost.push({ currency: usage.cost.currency, amount: usage.cost.amount, attempts: 1 });
    }
  }
  return [...byAdapter.values()].sort((x, y) => (x.adapter < y.adapter ? -1 : x.adapter > y.adapter ? 1 : 0));
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A sum of money for reading: floating-point noise from adding many costs is rounded off (the ledger keeps the exact numbers). */
export const money = (amount: number): string => String(Number(amount.toFixed(6)));

/**
 * Source labels that differ only in their numbers (an adapter names per-attempt counts in its label) shown once, with
 * each number that varies between them replaced by "…".
 */
export function sourcesText(sources: readonly string[]): string {
  const groups = new Map<string, string[][]>();
  for (const source of sources) {
    const shape = source.replace(/\d+(\.\d+)?/g, "#");
    groups.set(shape, [...(groups.get(shape) ?? []), source.match(/\d+(\.\d+)?/g) ?? []]);
  }
  return [...groups].map(([shape, numbers]) => {
    let index = 0;
    return shape.replace(/#/g, () => {
      const values = new Set(numbers.map((list) => list[index]));
      index += 1;
      return values.size === 1 ? [...values][0]! : "…";
    });
  }).join("; ");
}

/** `heading`, then one line per adapter, each indented by `indent` beyond it; nothing when no attempt ran. */
export function usageLines(usage: readonly UsageSummary[], heading: string, indent: string): string[] {
  if (usage.length === 0) return [];
  const lines = [`${indent}${heading}`];
  for (const summary of usage) {
    if (summary.reported === 0) {
      lines.push(`${indent}  ${summary.adapter}: none reported by ${plural(summary.attempts, "attempt")}`);
      continue;
    }
    const counts = USAGE_COUNTS.filter((count) => summary.counts[count].attempts > 0).map((count) => `${count} ${summary.counts[count].sum} (${summary.counts[count].attempts})`);
    const costs = summary.cost.map((cost) => `cost ${money(cost.amount)} ${cost.currency} (${cost.attempts})`);
    lines.push(`${indent}  ${summary.adapter}: ${summary.reported} of ${plural(summary.attempts, "attempt")} reported; ${[...counts, ...costs].join(", ")}; source: ${sourcesText(summary.sources)}`);
  }
  return lines;
}
