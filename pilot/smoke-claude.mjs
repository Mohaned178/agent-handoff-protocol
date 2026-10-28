// A one-trial smoke test with a real coding agent: the full AHP pipeline (C3: plan → implement → review, verified, with
// retry and send-back) on the password-reset task, every step on Claude Code, scored by the task's hidden tests.
// Run with `node src/cli/bin.ts eval pilot/smoke-claude.mjs --out smoke-run` (unset ANTHROPIC_API_KEY first). It is not
// the pilot: one trial says whether the pipeline works with a real tool, nothing about the hypothesis.
export default {
  name: "smoke-claude",
  tasks: ["./tasks/password-reset"],
  conditions: ["C3"],
  agents: {
    plan: { adapter: "claude-code" },
    implement: { adapter: "claude-code" },
    review: { adapter: "claude-code" },
  },
  retryBudget: 1,
  repeats: 1,
  spendCap: { amount: 5, currency: "USD" },
};
