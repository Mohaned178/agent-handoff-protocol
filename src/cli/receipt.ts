// The receipt at a run's end: what AHP's checks caught that an agent alone would not have said, read from the run's
// state and nothing else. An agent's report is a claim, so the receipt says an agent "reported done", never that work
// "was done"; and it says only what the ledger records: no "would have", no estimate of time or money saved.

import { reviewVerdictOf, THIS_REPOSITORY, type AttemptView, type ChangedPath, type EvidenceItem, type RunView, type StepView } from "../protocol/index.ts";
import { money, sourcesText, summarizeUsage, usageLines } from "../runtime/index.ts";

const RUN_USAGE_HEADING = "usage, as each tool reported it (per adapter, not summed across adapters; nothing is estimated):";

/** What a run's attempts reported using, summed per adapter; null before any attempt. */
export function formatRunUsage(state: Readonly<RunView>, indent = ""): string | null {
  const lines = usageLines(summarizeUsage(state.steps.flatMap((step) => step.attempts)), RUN_USAGE_HEADING, indent);
  return lines.length > 0 ? lines.join("\n") : null;
}

const HEADING = "what the checks found (from the run's ledger: an agent's report is a claim, a check decides):";

const times = (count: number) => `${count} ${count === 1 ? "time" : "times"}`;
const changesOf = (changed: readonly ChangedPath[]) => changed.map(({ change, path }) => `${change} ${path}`).join(", ");

/** The line of a failed check's output that says what failed: the first that looks like a failure, else the last. */
function failingLine(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /fail|error|assert|wrong|missing|expected|not ok|✗|×/i.test(line)) ?? lines.at(-1) ?? "(no output)";
}

/** Why an attempt's verification failed, in one line. */
function whyFailed(evidence: readonly EvidenceItem[]): string {
  for (const item of evidence) {
    if (item.kind === "protected_paths" && item.violations.length > 0) return `refused: it changed a protected path (${changesOf(item.violations)}), so its check was not run`;
    if (item.kind === "forbidden_external_action_detected") {
      return `refused: a shared ref moved while it ran (${item.changed.map((change) => change.name).join(", ")}); only AHP pushes, so its check was not run`;
    }
  }
  for (const item of evidence) {
    if (item.kind === "test_output" && item.exitCode !== 0) return failingLine(item.output);
    if (item.kind === "required_output_fields" && item.missing.length > 0) return `it did not report ${item.missing.join(", ")}`;
    if (item.kind === "review_verdict" && item.verdict === null) return `its verdict was not understood (${JSON.stringify(item.reported)})`;
  }
  return "its verification failed";
}

/** Why an attempt failed, in one line: the tool's error, or what its verification found; null when it did not fail. */
export function failureLineOf(attempt: AttemptView): string | null {
  if (attempt.error) return attempt.error.message.split(/\r?\n/)[0]!;
  if (attempt.verification?.state === "fail") return whyFailed(attempt.verification.evidence);
  return null;
}

/** The check command of a step: the last one its verifications ran, or null for a step that has none. */
const commandOf = (step: StepView) => step.attempts.map((attempt) => attempt.verification?.command ?? null).filter((command) => command !== null).at(-1) ?? null;

function checkLines(step: StepView): string[] {
  const command = commandOf(step);
  const lines: string[] = [];
  if (command !== null && step.state === "succeeded") lines.push(`  ${step.id}: verified: \`${command}\` passed in a clean copy`);
  if (command !== null && step.state === "failed") lines.push(`  ${step.id}: not verified: \`${command}\` failed`);
  const failed = step.attempts.filter((attempt) => attempt.verification?.state === "fail");
  if (failed.length > 0) {
    const passed = step.attempts.some((attempt) => attempt.verification?.state === "pass");
    lines.push(
      passed
        ? `  ${step.id}: the agent reported done ${times(failed.length)} before its check passed:`
        : `  ${step.id}: the agent reported done ${times(failed.length)}; its check never passed:`,
      ...failed.map((attempt) => `    attempt ${attempt.number}: ${whyFailed(attempt.verification!.evidence)}`),
    );
  }
  return lines;
}

/** What became of a revision a review sent back: what the review's next attempt concluded, if it ran. */
function afterReview(review: StepView | undefined, sentBackBy: string): string {
  const index = review?.attempts.findIndex((attempt) => attempt.id === sentBackBy) ?? -1;
  const next: AttemptView | undefined = index < 0 ? undefined : review!.attempts.slice(index + 1).find((attempt) => attempt.state === "exited");
  if (!next) return "the revision has not been reviewed again";
  const verdict = next.verification?.state === "pass" ? reviewVerdictOf(next.reportedOutput) : null;
  if (verdict === "approved") return "the next review approved the revision";
  if (verdict === "changes_requested") return "the next review asked for changes again";
  return "the next review did not reach a verdict";
}

/** What a gate's next decision on the revision a person rejected was. */
function afterRejection(gate: StepView | undefined, decidedAt: string): string {
  const next = gate?.approvals.find((approval) => approval.requestedAt > decidedAt)?.decision ?? null;
  if (next === null) return "the revision has not been decided again";
  return next.decision === "approved" ? "the revision was approved at the gate" : "the revision was rejected again";
}

function sendBackLines(step: StepView, state: Readonly<RunView>): string[] {
  return step.attempts.flatMap((attempt) => {
    const sent = attempt.sentBack;
    if (sent === null) return [];
    const by = state.steps.find((candidate) => candidate.id === (sent.kind === "review" ? sent.reviewStepId : sent.gateStepId));
    return sent.kind === "review"
      ? [`  ${step.id}: sent back by ${sent.reviewStepId} (attempt ${attempt.number}):`, ...sent.findings.map((finding) => `    | ${finding}`), `    ${afterReview(by, sent.reviewAttemptId)}`]
      : [`  ${step.id}: rejected at ${sent.gateStepId} by ${sent.user} (attempt ${attempt.number}):`, ...sent.reason.split(/\r?\n/).map((line) => `    | ${line}`), `    ${afterRejection(by, sent.decidedAt)}`];
  });
}

const rejectionLines = (step: StepView) =>
  step.handoffs.flatMap((handoff) => (handoff.rejection ?? []).map((reason) => `  ${step.id}: refused: its handoff (revision ${handoff.revision}): ${reason.message}`));

const count = (n: number, word: string) => `${n === 1 ? "one" : n} ${word}${n === 1 ? "" : "s"}`;
const thousands = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/** One step's check in a line: passed or failed, with how many attempts failed it first and what review sent back. */
function briefCheck(step: StepView, state: Readonly<RunView>): string | null {
  const command = commandOf(step);
  if (command === null || (step.state !== "succeeded" && step.state !== "failed")) return null;
  if (step.state === "failed") return `✗ ${step.id}: \`${command}\` failed on ${count(step.attempts.filter((attempt) => attempt.verification?.state === "fail").length, "attempt")}`;
  const parts = [`✓ ${step.id}: \`${command}\` passed`];
  const failed = step.attempts.filter((attempt) => attempt.verification?.state === "fail").length;
  if (failed > 0) parts.push(`after ${count(failed, "failed attempt")}`);
  const sent = step.attempts.filter((attempt) => attempt.sentBack !== null);
  if (sent.length > 0) {
    const last = sent.at(-1)!.sentBack!;
    const by = state.steps.find((candidate) => candidate.id === (last.kind === "review" ? last.reviewStepId : last.gateStepId));
    const after = last.kind === "review" ? afterReview(by, last.reviewAttemptId) : afterRejection(by, last.decidedAt);
    parts.push(`sent back ${sent.length === 1 ? "once" : `${sent.length} times`}${after.includes("approved") ? ", approved after" : ""}`);
  }
  return parts.join(" · ");
}

/** What each tool reported using, one line per adapter: shortened numbers, and the source they came from. */
function briefUsage(state: Readonly<RunView>): string[] {
  return summarizeUsage(state.steps.flatMap((step) => step.attempts)).map((summary) => {
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
  const agentSteps = state.steps.filter((step) => step.kind === "agent" || step.kind === "review");
  const lines: string[] = [];
  if (!agentSteps.some((step) => commandOf(step) !== null)) lines.push("! not verified: no check command");
  for (const step of agentSteps) {
    const check = briefCheck(step, state);
    if (check) lines.push(check);
    for (const attempt of step.attempts) {
      const why = attempt.verification?.state === "fail" ? whyFailed(attempt.verification.evidence) : "";
      if (why.startsWith("refused: it ")) lines.push(`! ${step.id}: attempt ${attempt.number} ${why.slice("refused: it ".length)}`);
      else if (why.startsWith("refused: ")) lines.push(`! ${step.id}: attempt ${attempt.number}: ${why.slice("refused: ".length)}`);
    }
    for (const line of rejectionLines(step)) lines.push(`! ${line.trim()}`);
  }
  return [...lines, ...briefUsage(state)];
}

/** The one command to run next for a run in `state`, or null when there is nothing to do or it was said already. */
export function nextStepOf(state: Readonly<RunView>): string | null {
  switch (state.state) {
    case "succeeded": {
      const push = state.steps.map((step) => step.action?.target).filter((target) => target?.kind === "push_branch").at(-1);
      if (!push) return null;
      return push.remote === THIS_REPOSITORY ? `git merge ${push.branch}` : `open a pull request from ${push.branch} on ${push.remote}`;
    }
    case "failed":
      return `ahp inspect ${state.runId} shows every attempt and its evidence`;
    case "needs_recovery": {
      const awaiting = state.steps.flatMap((step) => step.attempts).filter((attempt) => attempt.recovery?.awaited && attempt.recovery.decision === null);
      return awaiting.length > 0 ? awaiting.map((attempt) => `ahp recover ${attempt.id} --policy adopt|abort`).join("; ") : `ahp recover ${state.runId}`;
    }
    case "pending":
    case "running":
      return `ahp recover ${state.runId} resumes it`;
    default:
      return null;
  }
}

/** The receipt of a run in `state`: the checks, what agents reported before them, what review sent back, what was refused, and usage. */
export function formatReceipt(state: Readonly<RunView>): string {
  const agentSteps = state.steps.filter((step) => step.kind === "agent" || step.kind === "review");
  const lines = [HEADING];
  if (!agentSteps.some((step) => commandOf(step) !== null)) lines.push("  not verified: no check command");
  for (const step of agentSteps) lines.push(...checkLines(step), ...sendBackLines(step, state), ...rejectionLines(step));
  const usage = formatRunUsage(state);
  if (usage) lines.push(usage);
  return lines.join("\n");
}
