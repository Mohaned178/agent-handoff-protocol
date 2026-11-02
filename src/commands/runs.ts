// What a run is waiting for, read from its listing: the one place that says "a person must decide", so the home screen's
// "waiting for you" and `/clean`'s "never remove what a person may need" cannot drift apart.

import type { RunView } from "../protocol/index.ts";
import type { RunListing } from "../sdk/run.ts";

/** The states in which a run is over: nothing will write its ledger again. */
export const ENDED_STATES = ["succeeded", "failed", "cancelled"] as const satisfies readonly RunView["state"][];

/**
 * Why a run waits for a person, in words, or null when it does not: an approval gate, an attempt whose outcome is unknown, or
 * a run whose process stopped partway (no live lock).
 */
export function waitingDetail(listing: RunListing, state: RunView): string | null {
  if (state.state === "waiting_approval") {
    const gate = state.steps.find((step) => step.state === "waiting_approval");
    return `waiting for your approval${gate ? ` at ${gate.id}` : ""}`;
  }
  if (state.state === "needs_recovery") {
    const step = state.steps.find((candidate) => candidate.state === "needs_recovery");
    return `needs recovery${step ? ` at ${step.id}` : ""}: an attempt's outcome is unknown`;
  }
  if ((state.state === "pending" || state.state === "running") && listing.lock.state !== "held" && listing.lock.state !== "other_host") return "its process stopped partway";
  return null;
}
