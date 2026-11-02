// The `ahp` executable's body. `bin/ahp.mjs` checks the Node version before loading it. On a terminal, `ahp` opens the app
// and `ahp "<task>"` opens it on that task's summary; every other call is a plain command (`src/commands/`).
import { parseInvocation } from "../commands/args.ts";
import { main } from "../commands/main.ts";

const argv = process.argv.slice(2);

/** What the app should open on, or null when this call is for the plain commands. */
function appCall(): { task?: string } | null {
  let interactive = false;
  try {
    interactive = process.stdout.isTTY === true && process.stdin.isTTY === true && !process.env.CI;
  } catch {
    return null;
  }
  if (!interactive) return null;
  try {
    const invocation = parseInvocation(argv);
    // A task with a flag (`--yes`, `--mock`, ...) is the scripted form: the plain command answers it.
    if (invocation.kind === "task" && Object.keys(invocation.values).length === 0) return { task: invocation.task };
    // No arguments: `parseInvocation` calls that "usage"; on a terminal it is the app. `--help` is also "usage", so look at argv.
    if (argv.length === 0) return {};
  } catch {
    // A mistake in the arguments is the plain command's to report.
  }
  return null;
}

const app = appCall();
if (app === null) {
  process.exitCode = await main(argv);
} else {
  const { openApp } = await import("../tui/open.ts");
  process.exitCode = await openApp(app);
}
