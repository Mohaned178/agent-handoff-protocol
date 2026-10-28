import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fakeToolsDir, installFakeToolScript } from "./fake-tools.ts";

type Json = Record<string, unknown>;

/**
 * Messages of `gemini --acp` 0.42.0. Two were printed by the real tool (`initialize`, `newSessionAuthError`); every other
 * one was written from the tool's source and never seen on a live run (see `_provenance` in the file). `{{workspace}}`
 * is filled in by the fake.
 */
export const captures = JSON.parse(readFileSync(new URL("../fixtures/gemini-cli/captures.json", import.meta.url), "utf8")) as Record<string, any>;

/** One step of what the fake agent does during `session/prompt`. */
export type PromptStep =
  /** Sends a notification (or any message) to the client. */
  | { send: Json }
  /** Sends a request to the client (numbered from 0, as the client numbers its own) and records the client's answer. */
  | { request: Json }
  | { wait: number }
  /** Waits for `session/cancel`; with `ignoreCancel` set in the scenario, for ever. */
  | { hangUntilCancel: true }
  /** Starts a process that ignores every termination signal and writes its PID to this file. */
  | { spawnStubborn: string }
  /** Exits at once with this code, mid-turn. */
  | { exit: number };

export interface FakeGeminiScenario {
  initialize?: Json;
  /** The result of `session/new`, or `{ error }`. */
  newSession?: Json | { error: Json };
  prompt: { steps: PromptStep[]; result?: Json; error?: Json; cancelledResult?: Json };
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
export interface FakeGeminiCall {
  argv: string[];
  cwd: string;
  pwd: string | undefined;
  /** The text of each file named by a `--policy` argument, as it was when the fake started. */
  policyFiles: Record<string, string>;
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
const policyFiles = {};
argv.forEach((arg, i) => { if (argv[i - 1] === "--policy") { try { policyFiles[arg] = fs.readFileSync(arg, "utf8"); } catch (e) { policyFiles[arg] = "unreadable: " + e.message; } } });
const call = { argv, cwd: process.cwd(), pwd: process.env.PWD, policyFiles, received: [], agentRequests: [], stdinEnded: false, pid: process.pid };
const save = () => fs.writeFileSync(callsDir + "/" + process.pid + ".json", JSON.stringify(call));
save();
const escaped = (text) => JSON.stringify(text).slice(1, -1);
const fill = (value) => JSON.parse(JSON.stringify(value).split("{{workspace}}").join(escaped(process.cwd().split("\\").join("/"))));
const send = (message) => process.stdout.write(JSON.stringify(fill(message)) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, error) => send({ jsonrpc: "2.0", id, error });
const answer = (id, outcome) => ("error" in outcome ? replyError(id, outcome.error) : reply(id, outcome));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (scenario.crashAtStart !== undefined) process.exit(scenario.crashAtStart);

if (argv.includes("--acp")) {
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
      case "session/prompt": return void prompt(message);
      case "session/cancel":
        cancelled = true;
        if (scenario.killChildOnCancel && child) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
        if (!scenario.ignoreCancel) for (const wake of cancelWaiters.splice(0)) wake();
        return;
      default:
        if (message.id !== undefined) replyError(message.id, { code: -32601, message: "Method not found: " + message.method });
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
 * Installs a fake `gemini` that speaks ACP over stdio as the messages in the fixture do, doing what `scenario` says, and
 * puts it first on this process's PATH until `restore()`. The real `gemini` is never run by a test.
 */
export function installFakeGemini(scenario: FakeGeminiScenario) {
  const { dir } = fakeToolsDir();
  const callsDir = join(dir, "calls");
  mkdirSync(callsDir);
  // The scenario goes in as a string literal of its JSON; replacer functions keep `$` in the text from being read as a pattern.
  const script = FAKE.replace("__SCENARIO__", () => JSON.stringify(JSON.stringify(scenario))).replace("__CALLS__", () => JSON.stringify(callsDir));
  installFakeToolScript(dir, "gemini", script);
  const before = process.env.PATH;
  process.env.PATH = [dir, before].join(delimiter);
  return {
    dir,
    calls: (): FakeGeminiCall[] => readCalls(callsDir),
    /** The one `gemini --acp` run. */
    acp: (): FakeGeminiCall => {
      const runs = readCalls(callsDir).filter((run) => run.argv.includes("--acp"));
      if (runs.length !== 1) throw new Error(`expected one gemini --acp run, saw ${runs.length}`);
      return runs[0]!;
    },
    restore: () => {
      process.env.PATH = before;
    },
  };
}

/** The scenario of a turn that completes: thinking, a tool call, the reply, then the result with the tool's usage. */
export const completingScenario = (overrides: Partial<FakeGeminiScenario> = {}): FakeGeminiScenario => ({
  initialize: captures.initialize,
  newSession: captures.newSession,
  prompt: { steps: [{ send: captures.commands }, { send: captures.thought }, { send: captures.modeUpdate }, { send: captures.messageChunkOk }], result: captures.completeResult },
  ...overrides,
});

/** The fake's call files; one it is writing at this moment reads as torn, and is left out until the next read. */
function readCalls(callsDir: string): FakeGeminiCall[] {
  return readdirSync(callsDir).flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(join(callsDir, name), "utf8")) as FakeGeminiCall];
    } catch {
      return [];
    }
  });
}
