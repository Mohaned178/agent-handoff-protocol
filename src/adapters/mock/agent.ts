// The mock coding agent: one process per attempt. It reads its script as JSON on stdin,
// applies the scripted edits inside its working directory, reports the scripted output fields as a
// JSON document on stdout, and exits with the scripted code. Diagnostics go to stderr.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { text } from "node:stream/consumers";
import type { MockAttemptScript } from "./index.ts";

const script = JSON.parse(await text(process.stdin)) as MockAttemptScript;
const workspace = process.cwd();

for (const edit of script.edits ?? []) {
  const target = resolve(workspace, edit.path);
  const fromWorkspace = relative(workspace, target);
  if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
    console.error(`mock agent: refusing to edit outside the workspace: ${edit.path}`);
    process.exit(2);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, edit.content);
  console.error(`mock agent: wrote ${edit.path}`);
}

process.stdout.write(JSON.stringify({ outputFields: script.outputFields ?? {} }));
// Not process.exit(): it may cut off output still buffered for a pipe.
process.exitCode = script.exitCode ?? 0;
