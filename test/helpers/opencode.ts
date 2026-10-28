import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fakeToolsDir, installFakeToolScript } from "./fake-tools.ts";

type Json = Record<string, unknown>;

/** Messages captured from `opencode acp` 1.18.35 (scrubbed; see the file). `{{workspace}}` is filled in by the fake. */
export const captures = JSON.parse(readFileSync(new URL("../fixtures/opencode/captures.json", import.meta.url), "utf8")) as Record<string, any>;

/** One step of what the fake agent does during `session/prompt`. */
export type PromptStep =
  /** Sends a notification (or any message) to the client. */
  | { send: Json }
  /** Sends a request to the client (the fake numbers its own from 0, as OpenCode does) and records the client's answer. */
  | { request: Json }
  | { wait: number }
  /** Waits for `session/cancel`; with `ignoreCancel` set in the scenario, for ever. */
  | { hangUntilCancel: true }
  /** Starts a process that ignores every termination signal and writes its PID, then the fake's own, to this file. */
  | { spawnStubborn: string }
  /** Exits at once with this code, mid-turn. */
  | { exit: number };

export interface FakeOpencodeScenario {
  initialize?: Json | { error: Json };
  newSession?: Json | { error: Json };
  /** The answer to `session/set_config_option`. */
  setModel?: { result: Json } | { error: Json };
  prompt: { steps: PromptStep[]; result?: Json; error?: Json; cancelledResult?: Json };
  /** What `opencode export <session>` prints, and its exit code. */
  export?: { json: Json; exitCode?: number };
  /** The fake does not answer `session/cancel`. */
  ignoreCancel?: boolean;
  /** `session/cancel` kills the process the fake started with `spawnStubborn`. */
  killChildOnCancel?: boolean;
  /** Never exits when its stdin ends. */
  ignoreStdinEnd?: boolean;
  /** Exits non-zero before answering anything. */
  crashAtStart?: number;
}

/** What one run of the fake saw, written for the test to read. */
export interface FakeOpencodeCall {
  argv: string[];
  cwd: string;
  pwd: string | undefined;
  env: Record<string, string | undefined>;
  /** Every message the client sent, in order. */
  received: Json[];
  /** Each request the fake made, with the client's answer to it. */
  agentRequests: { request: Json; response: Json }[];
  stdinEnded: boolean;
  pid: number;
}

const FAKE = String.raw`
const fs = require("fs");
const { spawn } = require("child_process");
const scenario = JSON.parse(__SCENARIO__);
const callsDir = __CALLS__;
const argv = process.argv.slice(2);
const call = {
  argv, cwd: process.cwd(), pwd: process.env.PWD,
  env: { OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT, OPENCODE_DISABLE_CLAUDE_CODE: process.env.OPENCODE_DISABLE_CLAUDE_CODE, OPENCODE_DISABLE_EXTERNAL_SKILLS: process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, XDG_DATA_HOME: process.env.XDG_DATA_HOME },
  received: [], agentRequests: [], stdinEnded: false, pid: process.pid,
};
const save = () => fs.writeFileSync(callsDir + "/" + process.pid + ".json", JSON.stringify(call));
save();
// The captures were made on Windows: a backslash right after the workspace is a path separator, here as on the machine running the test.
const escaped = (text) => JSON.stringify(text).slice(1, -1);
const fill = (value) => JSON.parse(JSON.stringify(value).split("{{workspace}}\\\\").join(escaped(process.cwd() + require("path").sep)).split("{{workspace}}").join(escaped(process.cwd())));
const send = (message) => process.stdout.write(JSON.stringify(fill(message)) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, error) => send({ jsonrpc: "2.0", id, error });
const answer = (id, outcome) => ("error" in outcome ? replyError(id, outcome.error) : reply(id, outcome));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (scenario.crashAtStart !== undefined) process.exit(scenario.crashAtStart);

if (argv[0] === "export") {
  if (scenario.export) process.stdout.write(JSON.stringify(fill(scenario.export.json)));
  process.exitCode = scenario.export ? scenario.export.exitCode || 0 : 1;
} else if (argv[0] === "acp") {
  let nextAgentId = 0;
  const waitingForClient = new Map();
  let cancelled = false;
  const cancelWaiters = [];
  let child = null;
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) handle(JSON.parse(line));
  });
  process.stdin.on("end", () => {
    call.stdinEnded = true;
    save();
    if (!scenario.ignoreStdinEnd) process.exit(0);
  });
  const handle = (message) => {
    call.received.push(message);
    save();
    if (message.method === undefined && waitingForClient.has(message.id)) {
      waitingForClient.get(message.id)(message);
      return;
    }
    switch (message.method) {
      case "initialize": return answer(message.id, scenario.initialize || {});
      case "session/new": return answer(message.id, scenario.newSession || {});
      case "session/set_config_option": return answer(message.id, scenario.setModel ? ("result" in scenario.setModel ? scenario.setModel.result : scenario.setModel) : { configOptions: [] });
      case "session/prompt": return void prompt(message);
      case "session/cancel":
        cancelled = true;
        if (scenario.killChildOnCancel && child) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
        if (!scenario.ignoreCancel) for (const wake of cancelWaiters.splice(0)) wake();
        return;
    }
  };
  const prompt = async (message) => {
    for (const step of scenario.prompt.steps) {
      if (step.send) send(step.send);
      else if (step.request) {
        const id = nextAgentId++;
        const answered = new Promise((resolve) => waitingForClient.set(id, resolve));
        send({ ...step.request, jsonrpc: "2.0", id });
        const response = await answered;
        call.agentRequests.push({ request: fill({ ...step.request, id }), response });
        save();
      } else if (step.wait) await sleep(step.wait);
      else if (step.hangUntilCancel) await new Promise((resolve) => { if (cancelled && !scenario.ignoreCancel) resolve(); else cancelWaiters.push(resolve); });
      else if (step.spawnStubborn) {
        const ignore = 'for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {}); setTimeout(() => {}, 600000);';
        child = spawn(process.execPath, ["-e", ignore], { stdio: "ignore", windowsHide: true });
        fs.writeFileSync(step.spawnStubborn, child.pid + "\n");
      } else if (step.exit !== undefined) process.exit(step.exit);
    }
    if (cancelled) reply(message.id, scenario.prompt.cancelledResult || { stopReason: "cancelled" });
    else if (scenario.prompt.error) replyError(message.id, scenario.prompt.error);
    else reply(message.id, scenario.prompt.result || { stopReason: "end_turn" });
  };
  setInterval(() => {}, 60000).unref();
  process.stdin.resume();
}
`;

/**
 * Installs a fake `opencode` that speaks ACP over stdio as the captured transcripts do, doing what `scenario` says, and
 * puts it first on this process's PATH until `restore()`. The real `opencode` is never run by a test.
 */
export function installFakeOpencode(scenario: FakeOpencodeScenario) {
  const { dir } = fakeToolsDir();
  const callsDir = join(dir, "calls");
  mkdirSync(callsDir);
  // The scenario goes in as a string literal of its JSON; replacer functions keep `$` in the text from being read as a pattern.
  const script = FAKE.replace("__SCENARIO__", () => JSON.stringify(JSON.stringify(scenario))).replace("__CALLS__", () => JSON.stringify(callsDir));
  installFakeToolScript(dir, "opencode", script);
  const before = process.env.PATH;
  process.env.PATH = [dir, before].join(delimiter);
  return {
    dir,
    /** Every run of the fake so far (`acp` and `export`), by start order of their PIDs' files. */
    calls: (): FakeOpencodeCall[] => readCalls(callsDir),
    /** The one `opencode acp` run. */
    acp: (): FakeOpencodeCall => {
      const runs = readCalls(callsDir)
        .filter((run) => run.argv[0] === "acp");
      if (runs.length !== 1) throw new Error(`expected one opencode acp run, saw ${runs.length}`);
      return runs[0]!;
    },
    restore: () => {
      process.env.PATH = before;
    },
  };
}

/** The scenario of a turn that completes: thinking, a reply, the usage update, then the result. */
export const completingScenario = (overrides: Partial<FakeOpencodeScenario> = {}): FakeOpencodeScenario => ({
  initialize: captures.initialize,
  newSession: captures.newSession,
  prompt: { steps: [{ send: captures.commands }, { send: captures.thought }, { send: captures.messageChunkOk }, { send: captures.usageUpdate }], result: captures.completeResult },
  export: { json: captures.export },
  ...overrides,
});

/** The fake's call files; one it is writing at this moment reads as torn, and is left out until the next read. */
function readCalls(callsDir: string): FakeOpencodeCall[] {
  return readdirSync(callsDir).flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(join(callsDir, name), "utf8")) as FakeOpencodeCall];
    } catch {
      return [];
    }
  });
}
