// The OpenCode adapter as a conformance subject. The real tool is told in words what to do, so a run depends on the model
// following an instruction: a scenario the tool cannot be made to do reliably is left out, and its check is skipped,
// never passed. Left out: `login_problem` (the free model needs no login, and a model the tool does not list is a
// different failure), `rate_limited` (no way to cause one), `no_model_report` and `no_usage_report` (the tool states both
// on every run), and the probes of the levels the adapter declares `cooperative` (all of them): the suite checks those
// only as accepted.
//
// The model is requested by name, so the model OpenCode records equals the request, and the suite skips that check as an
// echo it cannot tell from a report. The default is OpenCode's free tier, which needs no login or payment; set
// AHP_CONFORMANCE_OPENCODE_MODEL for another one (as `provider/model`, one the tool's session lists).
//
// Run by the maintainer on their machine, never in CI: `npm run conformance -- run opencode`. Unset OPENAI_API_KEY and the
// like first: OpenCode picks provider keys up from the environment, and a model that bills one is not the free tier.

import { tmpdir } from "node:os";
import { probe } from "../../doctor/probe.ts";
import type { ConformanceSubject, ProvokerContext } from "../../conformance/index.ts";
import { opencode, openCodeAdapter, type OpenCodeOptions } from "./index.ts";

const slashes = (path: string) => path.replaceAll("\\", "/");

const options = (chosen: OpenCodeOptions): unknown => opencode(chosen).options;

/** The file is checked byte for byte, and OpenCode's own write tool adds no trailing newline, so the agent is told to write it with a shell command. */
const writeProbe = ({ probeFile, probeContent }: ProvokerContext) =>
  `with a shell command that writes exactly the bytes ${JSON.stringify(probeContent)} (the text, then one line feed, no carriage return): ` +
  `\`node -e "require('fs').writeFileSync('${probeFile}', '${probeContent.trim()}' + String.fromCharCode(10))"\``;

const completing = (context: ProvokerContext): OpenCodeOptions => ({
  reportFields: ["summary"],
  extraInstructions: `Create the file ${context.probeFile} in the working directory ${writeProbe(context)}. Then report \`summary\` as one sentence saying what you did. Do nothing else.`,
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

export function openCodeSubject(): ConformanceSubject {
  return {
    adapter: openCodeAdapter,
    requestedModel: process.env.AHP_CONFORMANCE_OPENCODE_MODEL || "opencode/deepseek-v4.1-flash-free",
    toolVersion: async () => {
      const result = await probe("opencode", ["--version"], { cwd: tmpdir() });
      const version = result.outcome === "exited" && result.exitCode === 0 ? /(\d+\.\d+\.\d+\S*)/.exec(result.stdout)?.[1] : undefined;
      if (!version) throw new Error("`opencode --version` did not print a version AHP could read: pass --tool-version");
      return version;
    },
    provokers: {
      completes: (context) => ({ options: options(completing(context)) }),
      reports_model: (context) => ({ options: options(completing(context)) }),
      reports_usage: (context) => ({ options: options(completing(context)) }),
      hangs: () => ({ options: options({ extraInstructions: "Run `node -e \"setTimeout(() => {}, 600000)\"` with a shell command and wait for it. Do nothing else." }) }),
      resists_cancel: ({ pidFile }) => ({
        options: options({
          extraInstructions:
            "Write a file named hang.js in the working directory with exactly the following content, then run `node hang.js` with a shell command and wait for it. Do nothing else.\n\n" +
            hangScript(pidFile),
        }),
      }),
    },
  };
}
