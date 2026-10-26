// The mock coding agent: one process per attempt. It reads its script as JSON on stdin,
// applies the scripted edits inside its working directory, reports the scripted output fields as a
// JSON document on stdout, and exits with the scripted code. Diagnostics go to stderr.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { text } from "node:stream/consumers";
import type { AppliedCapabilities } from "../../protocol/index.ts";
import type { MockAttemptScript } from "./index.ts";
import { MOCK_USAGE_SOURCE } from "./source.ts";

const script = JSON.parse(await text(process.stdin)) as MockAttemptScript & { asked: AppliedCapabilities };
// What the adapter asks of the agent. The mock agent is told and does nothing more about it, which is why it is `cooperative`.
for (const { kind, require } of script.asked.capabilities) console.error(`mock agent: asked for ${kind} (at least ${require}), not acted on`);
console.error(`mock agent: network stance ${script.asked.network.stance}, not acted on`);
const workspace = process.cwd();

/** The absolute path of `path` inside the workspace; exits when it points elsewhere. */
function inWorkspace(path: string): string {
  const target = resolve(workspace, path);
  const fromWorkspace = relative(workspace, target);
  if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
    console.error(`mock agent: refusing to touch a path outside the workspace: ${path}`);
    process.exit(2);
  }
  return target;
}

const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
if (script.ignoreSignals) for (const signal of TERMINATION_SIGNALS) process.on(signal, () => undefined);
let grandchild: number | null = null;
if (script.spawnGrandchild) {
  // It says when it ignores the signals, so a cancel sent after the PID file is written finds it doing so. It holds
  // none of the adapter's pipes, so the agent's exit is still seen as soon as it happens.
  const ignoring = `for (const s of ${JSON.stringify(TERMINATION_SIGNALS)}) process.on(s, () => {}); process.stdout.write("ready"); setTimeout(() => {}, 600000);`;
  const child = spawn(process.execPath, ["-e", ignoring], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  await new Promise((resolve, reject) => child.stdout.once("data", resolve).once("error", reject));
  child.stdout.destroy();
  grandchild = child.pid!;
  console.error(`mock agent: started grandchild ${grandchild}`);
}
if (script.pidFile) writeFileSync(script.pidFile, [process.pid, grandchild].filter((pid) => pid !== null).join("\n") + "\n");

for (const path of script.deletes ?? []) {
  rmSync(inWorkspace(path), { recursive: true, force: true });
  console.error(`mock agent: deleted ${path}`);
}
for (const edit of script.edits ?? []) {
  const target = inWorkspace(edit.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, edit.content);
  console.error(`mock agent: wrote ${edit.path}`);
}
if (script.commit) {
  // The agent's own commit, as a coding agent that commits its work would make it.
  execFileSync("git", ["add", "--all"], { stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Mock Agent", "-c", "user.email=mock@localhost", "commit", "--quiet", "--allow-empty", "--message", "mock agent work"],
    { stdio: "ignore" },
  );
  console.error("mock agent: committed");
}
for (const args of script.git ?? []) {
  try {
    execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  } catch (error) {
    console.error(`mock agent: git ${args.join(" ")} failed: ${(error as { stderr?: Buffer }).stderr?.toString() ?? error}`);
    process.exit(2);
  }
  console.error(`mock agent: ran git ${args.join(" ")}`);
}
if (script.hang) {
  console.error("mock agent: hanging until killed");
  // The timer keeps the process alive; the promise never settles.
  await new Promise(() => setInterval(() => undefined, 60_000));
}

// Only what the script reports: a number it does not give is not reported, and nothing is estimated.
const usage = script.usage && {
  source: MOCK_USAGE_SOURCE,
  inputTokens: script.usage.inputTokens ?? null,
  outputTokens: script.usage.outputTokens ?? null,
  totalTokens: script.usage.totalTokens ?? null,
  cachedInputTokens: script.usage.cachedInputTokens ?? null,
  cost: script.usage.cost ?? null,
};
process.stdout.write(
  JSON.stringify({
    outputFields: script.outputFields ?? {},
    stopReason: script.stopReason ?? null,
    error: script.error ?? null,
    reportedModel: script.reportedModel ?? null,
    usage: usage ?? null,
  }),
);
// Not process.exit(): it may cut off output still buffered for a pipe.
process.exitCode = script.exitCode ?? 0;
