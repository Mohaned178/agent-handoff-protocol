import { readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { fakeToolsDir, installFakeTool } from "./fake-tools.ts";

/** A stream captured from `codex exec --json` 0.146.0, scrubbed of paths, thread and request ids. */
export const fixture = (name: "complete" | "structured" | "not-logged-in" | "model-not-found" | "effort-refused" | "declined-commands"): string =>
  readFileSync(new URL(`../fixtures/codex/${name}.jsonl`, import.meta.url), "utf8");

/** What the fake `codex` saw, written for the test to read once the attempt has ended. */
export interface FakeCodexCall {
  argv: string[];
  stdin: string;
  cwd: string;
  pwd: string | undefined;
  codexHome: string | undefined;
  /** The content of the file `--output-schema` named, read while the process ran (the adapter removes it afterwards). */
  schema: unknown;
  schemaPath: string | null;
}

export interface FakeCodexOptions {
  /** What it prints on stdout, as is. */
  stream: string;
  exitCode?: number;
  /** After printing, wait until killed. */
  hang?: boolean;
  /** Printed after a short wait, as a process killed in mid-line leaves it. */
  tornTail?: string;
  /**
   * What the fake writes to its session log under `$CODEX_HOME/sessions/<day>/`, as Codex does: the lines, named for the
   * thread id on the stream's `thread.started`. The real log's other lines are not reproduced here: a test reads one field.
   */
  sessionLines?: object[];
  /** The day directory, as `YYYY/MM/DD` (default: one in 2026). */
  sessionDay?: string;
}

/**
 * Installs a fake `codex` that records how it was called and prints a captured stream, and puts it first on this
 * process's PATH until `restore()`. The real `codex` is never run by a test, and never reads the real Codex home: a test
 * that wants a session log passes the `codexHome` option.
 */
export function installFakeCodex(options: FakeCodexOptions) {
  const { dir, log } = fakeToolsDir();
  const callFile = `${log}.call.json`;
  const body = `
    const at = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
    const schemaPath = at("--output-schema");
    const schema = (() => { try { return schemaPath ? JSON.parse(fs.readFileSync(schemaPath, "utf8")) : null; } catch { return null; } })();
    fs.writeFileSync(${JSON.stringify(callFile)}, JSON.stringify({
      argv, stdin: Buffer.concat(chunks).toString(), cwd: process.cwd(), pwd: process.env.PWD, codexHome: process.env.CODEX_HOME, schema, schemaPath,
    }));
    const stream = ${JSON.stringify(options.stream)};
    const session = ${JSON.stringify(options.sessionLines ?? null)};
    if (session && process.env.CODEX_HOME) {
      const thread = /"thread_id":"([^"]+)"/.exec(stream)[1];
      const day = require("path").join(process.env.CODEX_HOME, "sessions", ${JSON.stringify(options.sessionDay ?? "2026/10/28")});
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(require("path").join(day, "rollout-2026-10-28T01-19-16-" + thread + ".jsonl"), session.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
    }
    process.stdout.write(stream);
    ${options.tornTail ? `process.stdout.write(${JSON.stringify(options.tornTail)});` : ""}
    ${options.hang ? "setInterval(() => {}, 60000);" : `process.exitCode = ${options.exitCode ?? 0};`}
  `;
  installFakeTool(dir, log, "codex", body);
  const before = process.env.PATH;
  process.env.PATH = [dir, before].join(delimiter);
  return {
    call: (): FakeCodexCall => JSON.parse(readFileSync(callFile, "utf8")) as FakeCodexCall,
    restore: () => {
      process.env.PATH = before;
    },
  };
}
