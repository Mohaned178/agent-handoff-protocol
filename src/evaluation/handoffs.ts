// The size of every handoff a trial's run issued, read back from that run's ledger (`handoff_issued`), so it is what the
// recipients were given and not what a condition meant to give them. One measure with the runtime's context budget.

import { contextBytesOf, type LedgerEvent } from "../protocol/index.ts";
import { readRunEvents } from "../sdk/index.ts";
import type { TrialHandoff } from "./events.ts";

/** The handoff revisions among a run's events, in the order they were issued, each with its context's size. */
export function handoffsIn(events: readonly LedgerEvent[]): TrialHandoff[] {
  const handoffs: TrialHandoff[] = [];
  for (const event of events) {
    if (event.type !== "handoff_issued") continue;
    const { handoff } = event;
    handoffs.push({
      stepId: handoff.to.stepId,
      fromStepId: handoff.from?.stepId ?? null,
      handoffId: handoff.handoffId,
      revision: handoff.revision,
      bytes: contextBytesOf(handoff.context.fields),
    });
  }
  return handoffs;
}

/** The handoffs of the run `runId` in the trial's repository. */
export async function handoffsOf(repo: string, runId: string): Promise<TrialHandoff[]> {
  return handoffsIn(await readRunEvents({ repo, runId }));
}
