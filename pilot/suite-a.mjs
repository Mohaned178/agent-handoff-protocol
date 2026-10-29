// Pilot combination A: the reference scenario's tools. Run with `ahp eval pilot/suite-a.mjs` (see docs/pilot.md first: it needs
// API-key logins in each tool, provider-console spend limits, and the budget decision of design doc §9, item 9).
//
// Not set here, because they are the maintainer's calls: `model` for each agent (a tool's own default runs when it is left
// out), `spendCap`, `maxIncidentRate` (the pilot exists to measure that rate) and `toolVersions` (`ahp doctor` shows what is
// installed; a trial records the version it found either way).
import { CONDITIONS, REPEATS, TASKS } from "./common.mjs";

export default {
  name: "pilot-a",
  tasks: TASKS,
  conditions: CONDITIONS,
  repeats: REPEATS,
  agents: {
    plan: { adapter: "claude-code" },
    implement: { adapter: "codex" },
    review: { adapter: "opencode" },
  },
};
