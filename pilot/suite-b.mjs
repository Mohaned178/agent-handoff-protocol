// Pilot combination B: the same three tools with their roles rotated, so that no tool has the same role as in combination A and
// a result is not one tool's showing in one role. Run with `ahp eval pilot/suite-b.mjs`; what to set first is in suite-a.mjs and docs/pilot.md.
import { REPEATS, TASKS } from "./common.mjs";

export default {
  name: "pilot-b",
  tasks: TASKS,
  repeats: REPEATS,
  agents: {
    plan: { adapter: "opencode" },
    implement: { adapter: "claude-code" },
    review: { adapter: "codex" },
  },
};
