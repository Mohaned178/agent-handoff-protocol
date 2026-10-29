// What the two pilot suites share: the tasks and the number of repeats (design doc §7: 5 to 8 tasks, 2 agent combinations, 3
// repeats per cell). Each suite file adds its own combination of agents. See docs/pilot.md.

/** The task directories, relative to this folder. */
export const TASKS = [
  "./tasks/password-reset",
  "./tasks/orders-listing",
  "./tasks/csv-export",
  "./tasks/config-merge",
  "./tasks/retry-backoff",
  "./tasks/inventory-reservation",
];

/** Trials per task and condition. */
export const REPEATS = 3;

/**
 * The conditions the pilot runs (ticket 27, decision 4): whether a pipeline beats one agent with the same acceptance check and
 * retry (C0V), with C0 and C1 for the ladder. C2 matters only if C3 beats C0V, and the matched-budget baseline is a ceiling,
 * not a rival; both are left out to keep the cost down.
 */
export const CONDITIONS = ["C0", "C0V", "C1", "C3min", "C3"];
