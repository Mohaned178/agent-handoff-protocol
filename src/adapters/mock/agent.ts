// The mock coding agent: one process per attempt. It reads its script as JSON on stdin,
// applies the scripted edits inside its working directory, reports the scripted output fields as a
// JSON document on stdout, and exits with the scripted code. Diagnostics go to stderr.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { text } from "node:stream/consumers";
import type { MockAttemptScript } from "./index.ts";

const script = JSON.parse(await text(process.stdin)) as MockAttemptScript;
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

process.stdout.write(JSON.stringify({ outputFields: script.outputFields ?? {} }));
// Not process.exit(): it may cut off output still buffered for a pipe.
process.exitCode = script.exitCode ?? 0;
