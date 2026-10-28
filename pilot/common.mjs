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
