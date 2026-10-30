// The mini pilot (one-command run, ticket 06): the pilot's first and cheapest slice. Three tasks, the three conditions that
// say whether a pipeline adds anything to one agent with a check and retry (C0, C0V, C3min), one repeat, one combination: 9
// trials, 12 to 36 agent attempts. It shows cost per trial and harness problems; at this size it cannot show a difference
// between conditions. See docs/pilot.md, "The mini pilot", before running it.
//
// Not set here, because they are the maintainer's calls and the budget decides them (design doc §9, item 9): `spendCap`,
// `maxIncidentRate` and `toolVersions`, nor a `model` for either agent. Set them, and each provider console's spend limit,
// before `ahp eval pilot/suite-mini.mjs`.

export default {
  name: "pilot-mini",
  tasks: ["./tasks/password-reset", "./tasks/csv-export", "./tasks/retry-backoff"],
  conditions: ["C0", "C0V", "C3min"],
  repeats: 1,
  agents: {
    // C0 and C0V are the implement agent alone; Claude Code reports a cost, so a spend cap sees what most trials spend.
    implement: { adapter: "claude-code" },
    review: { adapter: "codex" },
  },
};
