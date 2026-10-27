// The Claude Code adapter as a conformance subject. The real tool is told in words what to do, so a run depends on the
// model following an instruction: a scenario the tool cannot be made to do reliably is left out, and its check is
// skipped, never passed. Left out: `rate_limited` (no way to cause one), `no_model_report` and `no_usage_report` (the
// tool states both on every run), and the probes of `enforced_by_tool` levels (the adapter declares none).
//
// Run by the maintainer on their machine, under their own login, never in CI: `npm run conformance -- run claude-code`.

import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { probe } from "../../doctor/probe.ts";
import type { ConformanceSubject, ProvokerContext } from "../../conformance/index.ts";
import { claudeCode, claudeCodeAdapter, type ClaudeCodeOptions } from "./index.ts";

const slashes = (path: string) => path.replaceAll("\\", "/");

const options = (chosen: ClaudeCodeOptions): unknown => claudeCode(chosen).options;

/** The cheapest settings that still make the tool answer: a low effort. */
const LOW = { effort: "low" } as const;

const completing = ({ probeFile, probeContent }: ProvokerContext): ClaudeCodeOptions => ({
  ...LOW,
  reportFields: ["summary"],
  extraInstructions:
    `Create the file ${probeFile} in the working directory containing exactly the line "${probeContent.trim()}" and nothing else, ` +
    "using the Write tool. Then report `summary` as one sentence saying what you did. Do nothing else.",
});

/**
 * A script for the agent to write and run: it starts a child that ignores every termination signal, writes both PIDs
 * (its own and the child's) to `pidFile`, one per line, and waits. The agent is given the exact text rather than a
 * command line, so no shell quoting stands between the suite and the script.
 */
const hangScript = (pidFile: string) => `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const ignore = () => { for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {}); };
ignore();
const child = spawn(process.execPath, ["-e", 'for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {}); setTimeout(() => {}, 600000);'], { stdio: "ignore" });
writeFileSync(${JSON.stringify(slashes(pidFile))}, process.pid + "\\n" + child.pid + "\\n");
setTimeout(() => {}, 600000);
`;

export function claudeCodeSubject(): ConformanceSubject {
  return {
    adapter: claudeCodeAdapter,
    // An alias, so a full model name in the tool's report cannot be read as an echo of the request.
    requestedModel: "sonnet",
    toolVersion: async () => {
      const result = await probe("claude", ["--version"], { cwd: tmpdir() });
      const version = result.outcome === "exited" && result.exitCode === 0 ? /^\s*(\d+\.\d+\.\d+\S*)/.exec(result.stdout)?.[1] : undefined;
      if (!version) throw new Error("`claude --version` did not print a version AHP could read: pass --tool-version");
      return version;
    },
    provokers: {
      completes: (context) => ({ options: options(completing(context)) }),
      // Stopped by its own budget: the tool reports an error, and the attempt exits non-zero.
      fails: () => ({ options: options({ ...LOW, maxBudgetUsd: 0.0001, extraInstructions: "Reply with the word ok." }) }),
      // An empty config directory holds no login.
      login_problem: ({ pidFile }) => ({ options: options({ ...LOW, configDir: join(dirname(pidFile), "no-login"), extraInstructions: "Reply with the word ok." }) }),
      reports_model: (context) => ({ options: options(completing(context)) }),
      reports_usage: (context) => ({ options: options(completing(context)) }),
      hangs: () => ({ options: options({ ...LOW, extraInstructions: "Run `node -e \"setTimeout(() => {}, 600000)\"` with the Bash tool and wait for it. Do nothing else." }) }),
      resists_cancel: ({ pidFile }) => ({
        options: options({
          ...LOW,
          extraInstructions:
            "Write a file named hang.js in the working directory with exactly the following content, then run `node hang.js` with the Bash tool and wait for it. Do nothing else.\n\n" +
            `${hangScript(pidFile)}`,
        }),
      }),
    },
  };
}
