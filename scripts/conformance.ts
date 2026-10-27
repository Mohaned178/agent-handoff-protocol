// Runs the adapter conformance suite on this machine and records the result, or renders the support matrix from the
// results recorded so far. Real adapters are run here by the maintainer, never in CI.
//
//   npm run conformance -- run <adapter> [--tool-version <v>] [--out <dir>] [--only <id,id>]
//   npm run conformance -- matrix [--dir <dir>] [--adapters <a,b>]
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { claudeCodeSubject } from "../src/adapters/claude-code/conformance.ts";
import { codexSubject } from "../src/adapters/codex/conformance.ts";
import { mockSubject } from "../src/adapters/mock/conformance.ts";
import {
  ConformanceRefusedError,
  matrixOf,
  outcomeOf,
  readResults,
  recordResult,
  renderMatrix,
  runConformance,
  type ConformanceSubject,
} from "../src/conformance/index.ts";

/** The adapters that can be run, by name. An adapter's ticket adds its subject here. */
const subjects: Record<string, () => ConformanceSubject> = { mock: mockSubject, "claude-code": claudeCodeSubject, codex: codexSubject };

const defaultDir = fileURLToPath(new URL("../conformance/results", import.meta.url));

const USAGE = `Usage:
  npm run conformance -- run <adapter> [--tool-version <v>] [--out <dir>] [--only <id,id>]
  npm run conformance -- matrix [--dir <dir>] [--adapters <a,b>]

Adapters: ${Object.keys(subjects).join(", ")}
run records the result in <dir> (default conformance/results), except for the mock, which is recorded only with --out, and for --only, which is never recorded.
Exit codes: 0 passed, 1 failed, 2 refused or usage error, 3 untested (a check was skipped).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "tool-version": { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    dir: { type: "string" },
    adapters: { type: "string" },
  },
});
const [command, adapter] = positionals;

if (command === "matrix") {
  const results = readResults(values.dir ?? defaultDir);
  const names = values.adapters?.split(",") ?? [...new Set(results.filter((r) => !r.mock).map((r) => r.adapter))].sort();
  console.log(renderMatrix(matrixOf(results, names)));
} else if (command === "run" && adapter) {
  const make = subjects[adapter];
  if (!make) {
    console.error(`no adapter "${adapter}"\n\n${USAGE}`);
    process.exit(2);
  }
  try {
    const result = await runConformance(make(), { toolVersion: values["tool-version"], only: values.only?.split(",") });
    for (const check of result.checks) console.log(`${check.status.padEnd(14)} ${check.id}: ${check.detail}`);
    const outcome = outcomeOf(result);
    console.log(`\n${result.adapter}${result.mock ? " (mock: not evidence)" : ""} on ${result.osLabel}, tool ${result.toolVersion}: ${outcome}`);
    if (!values.only && (!result.mock || values.out)) console.log(`recorded in ${recordResult(result, values.out ?? defaultDir)}`);
    process.exit(outcome === "passed" ? 0 : outcome === "failed" ? 1 : 3);
  } catch (error) {
    if (!(error instanceof ConformanceRefusedError)) throw error;
    console.error(error.message);
    process.exit(2);
  }
} else {
  console.error(USAGE);
  process.exit(2);
}
