// A stand-in for the GitHub CLI: `node fake-gh.ts <state.json> <gh arguments...>`. It answers the three `gh pr`
// commands AHP runs from the pull requests in the state file, records every call's arguments and environment there,
// and fails with `fail` on stderr when the state says so, as `gh` would.

import { readFileSync, writeFileSync } from "node:fs";

interface FakePull {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
}

interface FakeState {
  pulls: FakePull[];
  calls: { args: string[]; promptDisabled: string | null }[];
  /** When set, every command fails with this on stderr. */
  fail?: string;
  /** The head commit a new pull request gets. */
  head: string;
}

const [stateFile, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile!, "utf8")) as FakeState;
state.calls.push({ args, promptDisabled: process.env.GH_PROMPT_DISABLED ?? null });
const save = () => writeFileSync(stateFile!, JSON.stringify(state));
const option = (name: string) => args[args.indexOf(name) + 1]!;

if (state.fail) {
  save();
  process.stderr.write(`${state.fail}\n`);
  process.exit(1);
}
const [group, command] = args;
if (group !== "pr") throw new Error(`fake gh: unexpected ${args.join(" ")}`);
switch (command) {
  case "list": {
    const fields = option("--json").split(",");
    const listed = state.pulls
      .filter((pr) => pr.headRefName === option("--head"))
      .reverse()
      .map((pr) => Object.fromEntries(fields.map((field) => [field, pr[field as keyof FakePull]])));
    process.stdout.write(JSON.stringify(listed));
    break;
  }
  case "create": {
    const number = state.pulls.length + 1;
    const url = `https://github.com/${option("--repo").split("/").slice(1).join("/")}/pull/${number}`;
    state.pulls.push({ number, url, state: "OPEN", headRefName: option("--head"), headRefOid: state.head, baseRefName: option("--base") });
    process.stdout.write(`${url}\n`);
    break;
  }
  case "merge": {
    const pr = state.pulls.find((p) => p.number === Number(args[2]));
    if (!pr || pr.headRefOid !== option("--match-head-commit")) {
      save();
      process.stderr.write("fake gh: head does not match\n");
      process.exit(1);
    }
    pr.state = "MERGED";
    break;
  }
  default:
    throw new Error(`fake gh: unexpected ${args.join(" ")}`);
}
save();
