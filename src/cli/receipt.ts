// The receipt at a run's end, as the old terminal layer prints it: rendered from `receiptOf` (`src/commands/receipt.ts`),
// which reads the run's state and nothing else. The app's run screen renders the same data; this file goes in ticket 09.

import type { RunView } from "../protocol/index.ts";
import { failingLineOf, failureLineOf, nextStepOf, receiptOf, type Receipt, type ReceiptStep } from "../commands/receipt.ts";
import { money, sourcesText, summarizeUsage, usageLines } from "../runtime/index.ts";

export { failingLineOf, failureLineOf, nextStepOf };

const RUN_USAGE_HEADING = "usage, as each tool reported it (per adapter, not summed across adapters; nothing is estimated):";

/** What a run's attempts reported using, summed per adapter; null before any attempt. */
export function formatRunUsage(state: Readonly<RunView>, indent = ""): string | null {
  const lines = usageLines(summarizeUsage(state.steps.flatMap((step) => step.attempts)), RUN_USAGE_HEADING, indent);
  return lines.length > 0 ? lines.join("\n") : null;
}

const HEADING = "what the checks found (from the run's ledger: an agent's report is a claim, a check decides):";

const times = (count: number) => (count === 1 ? "once" : `${count} times`);

function checkLines(step: ReceiptStep): string[] {
  const lines: string[] = [];
  if (step.verdict === "verified") lines.push(`  ${step.stepId}: verified: \`${step.command}\` passed in a clean copy`);
  if (step.verdict === "not_verified") lines.push(`  ${step.stepId}: not verified: \`${step.command}\` failed`);
  if (step.verdict === "ended_before_check") lines.push(`  ${step.stepId}: not verified: the step ended (${step.failureClass ?? "failed"}) before \`${step.command}\` ran`);
  if (step.reportedDone.length > 0) {
    lines.push(
      step.passedAfter
        ? `  ${step.stepId}: the agent reported done ${times(step.reportedDone.length)} before its check passed:`
        : `  ${step.stepId}: the agent reported done ${times(step.reportedDone.length)}; its check never passed:`,
      ...step.reportedDone.map(({ attempt, why }) => `    attempt ${attempt}: ${why}`),
    );
  }
  return lines;
}

const sendBackLines = (step: ReceiptStep): string[] =>
  step.sendBacks.flatMap((sent) =>
    sent.kind === "review"
      ? [`  ${step.stepId}: sent back by ${sent.by} (attempt ${sent.attempt}):`, ...sent.findings.map((finding) => `    | ${finding}`), `    ${sent.after}`]
      : [`  ${step.stepId}: rejected at ${sent.by} by ${sent.user} (attempt ${sent.attempt}):`, ...sent.reason.split(/\r?\n/).map((line) => `    | ${line}`), `    ${sent.after}`],
  );

const rejectionLines = (step: ReceiptStep) => step.handoffRefusals.map(({ revision, message }) => `  ${step.stepId}: refused: its handoff (revision ${revision}): ${message}`);

const count = (n: number, word: string) => `${n === 1 ? "one" : n} ${word}${n === 1 ? "" : "s"}`;
const thousands = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/** One step's check in a line: passed or failed, with how many attempts failed it first and what review sent back. */
function briefCheck(step: ReceiptStep): string | null {
  if (step.verdict === null) return null;
  if (step.verdict === "ended_before_check") return `✗ ${step.stepId}: ended (${step.failureClass ?? "failed"}) before \`${step.command}\` ran`;
  if (step.verdict === "not_verified") return `✗ ${step.stepId}: \`${step.command}\` failed on ${count(step.reportedDone.length, "attempt")}`;
  const parts = [`✓ ${step.stepId}: \`${step.command}\` passed`];
  if (step.reportedDone.length > 0) parts.push(`after ${count(step.reportedDone.length, "failed attempt")}`);
  if (step.sendBacks.length > 0) {
    const n = step.sendBacks.length;
    parts.push(`sent back ${n === 1 ? "once" : `${n} times`}${step.sendBacks.at(-1)!.approvedAfter ? ", approved after" : ""}`);
  }
  return parts.join(" · ");
}

/** What each tool reported using, one line per adapter: shortened numbers, and the source they came from. */
function briefUsage(receipt: Receipt): string[] {
  return receipt.usage.map((summary) => {
    if (summary.reported === 0) return `usage: ${summary.adapter} reported none`;
    const counts = [
      ...(summary.counts.inputTokens.attempts > 0 ? [`${thousands(summary.counts.inputTokens.sum)} in`] : []),
      ...(summary.counts.outputTokens.attempts > 0 ? [`${thousands(summary.counts.outputTokens.sum)} out`] : []),
      ...summary.cost.map((cost) => `${money(cost.amount)} ${cost.currency}`),
    ];
    const partial = summary.reported < summary.attempts ? `, ${summary.reported} of ${summary.attempts} attempts` : "";
    return `usage: ${summary.adapter} ${counts.join(" · ") || "reported"} (as reported${partial}; ${sourcesText(summary.sources)})`;
  });
}

/**
 * The receipt as a terminal shows it at a run's end: a line per checked step, a line per refusal, a line of usage per
 * tool. The full receipt, with every failing line and finding, is `ahp inspect`'s.
 */
export function formatBriefReceipt(state: Readonly<RunView>): string[] {
  const receipt = receiptOf(state);
  const lines: string[] = [];
  if (!receipt.checked) lines.push("! not verified: no check command");
  for (const step of receipt.steps) {
    const check = briefCheck(step);
    if (check) lines.push(check);
    for (const { attempt, why, refused } of step.reportedDone) {
      if (!refused) continue;
      lines.push(why.startsWith("refused: it ") ? `! ${step.stepId}: attempt ${attempt} ${why.slice("refused: it ".length)}` : `! ${step.stepId}: attempt ${attempt}: ${why.slice("refused: ".length)}`);
    }
    for (const line of rejectionLines(step)) lines.push(`! ${line.trim()}`);
  }
  return [...lines, ...briefUsage(receipt)];
}

/** The receipt of a run in `state`: the checks, what agents reported before them, what review sent back, what was refused, and usage. */
export function formatReceipt(state: Readonly<RunView>): string {
  const receipt = receiptOf(state);
  const lines = [HEADING];
  if (!receipt.checked) lines.push("  not verified: no check command");
  for (const step of receipt.steps) lines.push(...checkLines(step), ...sendBackLines(step), ...rejectionLines(step));
  const usage = formatRunUsage(state);
  if (usage) lines.push(usage);
  return lines.join("\n");
}
