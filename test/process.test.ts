import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutableNotFoundError, launch, resolveExecutable, type Executable } from "../src/process/index.ts";
import { isRunning, until } from "./helpers/process.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-process-")));
  dirs.push(dir);
  return dir;
}

function write(path: string, content: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** The `.cmd` shim npm writes for a package's JavaScript bin (cmd-shim), pointing at `target` under the shim's directory. */
const npmShim = (target: string) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r
`;

/** The older shim npm wrote before cmd-shim 4. */
const oldNpmShim = (target: string) => `@IF EXIST "%~dp0\\node.exe" (\r
  "%~dp0\\node.exe"  "%~dp0\\${target}" %*\r
) ELSE (\r
  @SETLOCAL\r
  @SET PATHEXT=%PATHEXT:;.JS;=;%\r
  node  "%~dp0\\${target}" %*\r
)\r
`;

const WINDOWS = { platform: "win32" as const };
const winEnv = (...path: string[]) => ({ PATH: path.join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1" });

describe("resolveExecutable on Windows", () => {
  it("runs an npm .cmd shim's JavaScript entry point with the current Node, never the shim", async () => {
    const bin = tempDir();
    write(join(bin, "agent.cmd"), npmShim("node_modules\\agent-cli\\bin\\agent.js"));
    const entry = write(join(bin, "node_modules", "agent-cli", "bin", "agent.js"), "");

    const resolved = await resolveExecutable("agent", { ...WINDOWS, env: winEnv(bin) });

    expect(resolved).toEqual({ file: process.execPath, prefixArgs: [entry], via: "npm_shim", path: join(bin, "agent.cmd") });
  });

  it("reads the shim npm wrote before cmd-shim 4", async () => {
    const bin = tempDir();
    write(join(bin, "agent.cmd"), oldNpmShim("node_modules\\agent-cli\\cli.js"));
    const entry = write(join(bin, "node_modules", "agent-cli", "cli.js"), "");

    const resolved = await resolveExecutable("agent", { ...WINDOWS, env: winEnv(bin) });

    expect(resolved.prefixArgs).toEqual([entry]);
    expect(resolved.file).toBe(process.execPath);
  });

  it("runs a shim's native .exe target directly", async () => {
    const bin = tempDir();
    write(join(bin, "agent.cmd"), `@ECHO off\r\n"%~dp0\\node_modules\\agent-cli\\agent.exe"   %*\r\n`);
    const exe = write(join(bin, "node_modules", "agent-cli", "agent.exe"), "");

    expect(await resolveExecutable("agent", { ...WINDOWS, env: winEnv(bin) })).toMatchObject({ file: exe, prefixArgs: [] });
  });

  it("uses a real .exe over a .cmd shim in the same directory", async () => {
    const bin = tempDir();
    write(join(bin, "agent.cmd"), npmShim("node_modules\\agent-cli\\agent.js"));
    write(join(bin, "node_modules", "agent-cli", "agent.js"), "");
    const exe = write(join(bin, "agent.exe"), "");

    expect(await resolveExecutable("agent", { ...WINDOWS, env: winEnv(bin) })).toEqual({ file: exe, prefixArgs: [], via: "executable", path: exe });
  });

  it("searches PATH in order, so the first directory with the command wins", async () => {
    const first = tempDir();
    const second = tempDir();
    write(join(first, "agent.cmd"), npmShim("node_modules\\agent-cli\\agent.js"));
    const entry = write(join(first, "node_modules", "agent-cli", "agent.js"), "");
    write(join(second, "agent.exe"), "");

    expect((await resolveExecutable("agent", { ...WINDOWS, env: winEnv(first, second) })).prefixArgs).toEqual([entry]);
  });

  it("refuses a .cmd that is not an npm shim for Node, rather than run it through cmd.exe", async () => {
    const bin = tempDir();
    write(join(bin, "agent.cmd"), "@ECHO off\r\necho hello & del /q *\r\n");

    const resolving = resolveExecutable("agent", { ...WINDOWS, env: winEnv(bin) });

    await expect(resolving).rejects.toThrow(ExecutableNotFoundError);
    await expect(resolving).rejects.toThrow(/not an npm shim .* never runs a \.cmd or \.bat file through cmd\.exe/);
  });

  it("refuses a shim whose entry point is missing", async () => {
    const bin = tempDir();
    write(join(bin, "agent.cmd"), npmShim("node_modules\\agent-cli\\gone.js"));

    await expect(resolveExecutable("agent", { ...WINDOWS, env: winEnv(bin) })).rejects.toThrow(/entry point .*gone\.js.* does not exist/);
  });

  it("says where it looked when the command is nowhere on PATH", async () => {
    const bin = tempDir();

    const resolving = resolveExecutable("agent", { ...WINDOWS, env: winEnv(bin) });

    await expect(resolving).rejects.toThrow(ExecutableNotFoundError);
    await expect(resolving).rejects.toThrow(`"agent" is not on PATH (1 directory searched, with extensions .com, .exe, .bat, .cmd)`);
  });
});

describe.skipIf(process.platform === "win32")("resolveExecutable on Linux and macOS", () => {
  it("finds an executable file on PATH and skips one that is not executable", async () => {
    const first = tempDir();
    const second = tempDir();
    write(join(first, "agent"), "#!/bin/sh\n");
    const executable = write(join(second, "agent"), "#!/bin/sh\n");
    chmodSync(executable, 0o755);

    expect(await resolveExecutable("agent", { env: { PATH: [first, second].join(":") } })).toEqual({
      file: executable,
      prefixArgs: [],
      via: "executable",
      path: executable,
    });
  });
});

/** Writes what it got on stdin and its arguments after the first to the file named by its first argument, as JSON. */
const ECHO_AGENT = `const fs = require("fs");
const [out, ...rest] = process.argv.slice(2);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => fs.writeFileSync(out, JSON.stringify({ stdin: Buffer.concat(chunks).toString("utf8"), argv: rest })));
`;

/** The echo agent installed as a command on PATH: an npm shim on Windows, a script with a shebang elsewhere. */
async function installEchoAgent(bin: string) {
  if (process.platform === "win32") {
    write(join(bin, "echo-agent.cmd"), npmShim("node_modules\\echo-agent\\cli.js"));
    write(join(bin, "node_modules", "echo-agent", "cli.js"), ECHO_AGENT);
  } else {
    chmodSync(write(join(bin, "echo-agent"), `#!/usr/bin/env node
${ECHO_AGENT}`), 0o755);
  }
  return resolveExecutable("echo-agent", { env: { ...process.env, PATH: [bin, process.env.PATH].join(delimiter) } });
}

const PROMPT = `Fix the bug & echo INJECTED > injected1.txt | calc ; touch injected2.txt
$(touch injected3.txt) \`touch injected4.txt\` "double" 'single' %PATH% ^& !PATH! <in >out\r\nlast line, no newline`;

describe("launch", () => {
  it("passes the prompt on stdin byte for byte, and arguments as they are, with nothing run by a shell", async () => {
    const bin = tempDir();
    const cwd = tempDir();
    const agent = await installEchoAgent(bin);
    const out = join(cwd, "out.json");
    const args = [out, "a & b", '"quoted"', "%PATH%", "$(touch injected5.txt)", "x; touch injected6.txt"];

    const started = await launch({ executable: agent, args, cwd, input: PROMPT });
    expect(await started.exited).toEqual({ exitCode: 0, signal: null });

    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ stdin: PROMPT, argv: args.slice(1) });
    for (const n of [1, 2, 3, 4, 5, 6]) expect(existsSync(join(cwd, `injected${n}.txt`))).toBe(false);
    if (process.platform === "win32") expect(agent).toMatchObject({ file: process.execPath, via: "npm_shim" });
  });

  it("sets PWD to the working directory, whatever PWD the parent inherited (a tool that follows PWD would leave the workspace)", async () => {
    const bin = tempDir();
    const cwd = tempDir();
    const elsewhere = tempDir();
    const script = write(join(bin, "pwd.js"), `require("fs").writeFileSync(process.argv[2], JSON.stringify({ pwd: process.env.PWD, cwd: process.cwd() }));`);
    const out = join(cwd, "out.json");

    // The caller's own env may even name PWD: the working directory wins, as the shell would have it.
    const started = await launch({ executable: node, args: [script, out], cwd, env: { PWD: elsewhere } });
    expect(await started.exited).toEqual({ exitCode: 0, signal: null });

    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ pwd: cwd, cwd });
  });

  it("in duplex mode keeps stdin open for the caller, so a tool can be talked to line by line until stdin is ended", async () => {
    const cwd = tempDir();
    const script = write(
      join(cwd, "upper.js"),
      `process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => process.stdout.write(chunk.toUpperCase())); process.stdin.on("end", () => process.exit(7));`,
    );

    const started = await launch({ executable: node, args: [script], cwd, duplex: true });
    started.stdout.setEncoding("utf8");
    const replies: string[] = [];
    started.stdout.on("data", (chunk: string) => replies.push(chunk));

    started.stdin!.write("first\n");
    await until(() => (replies.join("") === "FIRST\n" ? true : undefined), "the first reply");
    started.stdin!.write("second\n");
    await until(() => (replies.join("") === "FIRST\nSECOND\n" ? true : undefined), "the second reply");
    // The process is still running: nothing closed its stdin.
    expect(isRunning(started.pid)).toBe(true);

    started.stdin!.end();
    expect(await started.exited).toEqual({ exitCode: 7, signal: null });
  });

  it("in duplex mode still sets PWD and stops the whole tree", async () => {
    const dir = tempDir();
    const path = write(join(dir, "agent.js"), TREE_AGENT);
    const pidFile = join(dir, "pids");
    const started = await launch({ executable: node, args: [path, pidFile], cwd: dir, duplex: true, env: { PWD: tempDir() } });
    started.stdout.resume();
    const tree = await until(() => {
      const lines = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n") : [];
      return lines.length === 2 ? lines.map(Number) : undefined;
    }, "the agent to start its grandchild");

    expect(await started.terminate({ graceMs: 300 })).toEqual({ outcome: "stopped", forced: true, via: "tree_kill" });
    for (const pid of tree) expect(isRunning(pid)).toBe(false);
  });

  it("fails to start a command that is not there", async () => {
    const cwd = tempDir();
    const missing: Executable = { file: join(cwd, process.platform === "win32" ? "missing.exe" : "missing"), prefixArgs: [], via: "executable", path: "" };

    await expect(launch({ executable: missing, cwd })).rejects.toThrow(/could not start/);
  });
});

const node: Executable = { file: process.execPath, prefixArgs: [], via: "executable", path: process.execPath };

/**
 * An agent that starts a grandchild which ignores every termination signal, writes both PIDs to its first argument,
 * and hangs. With "ignore" as its second argument it ignores them too.
 */
const TREE_AGENT = `const { spawn } = require("child_process");
const fs = require("fs");
const ignore = () => { for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {}); };
if (process.argv[3] === "ignore") ignore();
const grandchild = spawn(process.execPath, ["-e", 'for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {}); process.stdout.write("ready"); setTimeout(() => {}, 600000);'], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
// Only once it ignores the signals: a test that terminates the tree as soon as it reads the PIDs must find it so.
grandchild.stdout.once("data", () => { grandchild.stdout.destroy(); fs.writeFileSync(process.argv[2], process.pid + "\\n" + grandchild.pid + "\\n"); });
setInterval(() => {}, 60000);
`;

/**
 * An agent whose child runs in a session of its own, as OpenCode's shell commands do (observed on Linux, ticket 18): the
 * agent's process group does not hold it. Writes the child's PID and its own, and the child ignores every signal.
 */
const DETACHED_TREE_AGENT = `const { spawn } = require("child_process");
const fs = require("fs");
const child = spawn(process.execPath, ["-e", 'for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {}); process.stdout.write("ready"); setTimeout(() => {}, 600000);'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => { child.stdout.destroy(); fs.writeFileSync(process.argv[2], process.pid + "\\n" + child.pid + "\\n"); });
setInterval(() => {}, 60000);
`;

/** Hangs until the file named by its first argument exists, then exits: a transport's cancel, as far as a test can tell. */
const STOPPABLE_AGENT = `const fs = require("fs");
setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(0); }, 50);
`;

/** Starts a Node script from `dir`, and the PIDs it writes there once it has started its tree, if it writes any. */
async function startScript(dir: string, script: string, args: string[] = []) {
  const path = write(join(dir, "agent.js"), script);
  const pidFile = join(dir, "pids");
  const started = await launch({ executable: node, args: [path, pidFile, ...args], cwd: dir });
  started.stdout.resume();
  const pids = () =>
    until(() => {
      const lines = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n") : [];
      return lines.length === 2 ? lines.map(Number) : undefined;
    }, "the agent to start its grandchild");
  return { started, pids, pidFile };
}

describe("terminate", () => {
  it("kills the whole tree, a grandchild that ignores signals included, and confirms every process gone", async () => {
    const dir = tempDir();
    const { started, pids } = await startScript(dir, TREE_AGENT);
    const tree = await pids();

    const termination = await started.terminate({ graceMs: 500 });

    // The agent stops on SIGTERM, but its grandchild ignores it, so only killing the group ends the tree; on Windows
    // there is no signal to send without a console, so the tree is always killed.
    expect(termination).toEqual({ outcome: "stopped", forced: true, via: "tree_kill" });
    for (const pid of tree) expect(isRunning(pid)).toBe(false);
    await started.exited;
  });

  it("finds a process the agent started in a session of its own, and kills it too, though the agent leaves at the transport's cancel", async () => {
    const dir = tempDir();
    const { started, pids, pidFile } = await startScript(dir, DETACHED_TREE_AGENT);
    const tree = await pids();
    const [, child] = tree as [number, number];

    // The transport's stop ends the agent and leaves its detached child, which is the case a process group cannot see.
    const termination = await started.terminate({
      graceful: async () => {
        process.kill(started.pid, "SIGKILL");
      },
      graceMs: 500,
    });

    expect(termination).toEqual({ outcome: "stopped", forced: true, via: "tree_kill" });
    expect(isRunning(child)).toBe(false);
    expect(isRunning(started.pid)).toBe(false);
    expect(existsSync(pidFile)).toBe(true);
  });

  it("asks first: an agent that stops on SIGTERM is not forced, except on Windows", async () => {
    const dir = tempDir();
    const { started } = await startScript(dir, STOPPABLE_AGENT);

    const termination = await started.terminate({ graceMs: 5_000 });

    expect(termination).toEqual(
      process.platform === "win32" ? { outcome: "stopped", forced: true, via: "tree_kill" } : { outcome: "stopped", forced: false, via: "signal" },
    );
    expect(isRunning(started.pid)).toBe(false);
  });

  it("uses the transport's cancel first when there is one", async () => {
    const dir = tempDir();
    const { started, pidFile } = await startScript(dir, STOPPABLE_AGENT);

    const termination = await started.terminate({ graceful: async () => writeFileSync(pidFile, "stop"), graceMs: 5_000 });

    expect(termination).toEqual({ outcome: "stopped", forced: false, via: "transport" });
    expect(await started.exited).toEqual({ exitCode: 0, signal: null });
  });

  it("kills the tree when the transport's cancel does not stop it in time", async () => {
    const dir = tempDir();
    const { started, pids } = await startScript(dir, TREE_AGENT, ["ignore"]);
    const tree = await pids();

    const termination = await started.terminate({ graceful: async () => undefined, graceMs: 300 });

    expect(termination).toEqual({ outcome: "stopped", forced: true, via: "tree_kill" });
    for (const pid of tree) expect(isRunning(pid)).toBe(false);
  });

  it("says nothing was sent when the process had already ended", async () => {
    const dir = tempDir();
    const { started } = await startScript(dir, "process.exit(0);");
    await started.exited;

    expect(await started.terminate()).toEqual({ outcome: "already_gone" });
  });
});
