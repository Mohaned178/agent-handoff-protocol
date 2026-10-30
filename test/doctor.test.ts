import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mockAdapter } from "../src/adapters/mock/index.ts";
import type { Adapter } from "../src/adapters/index.ts";
import { diagnose, type DoctorReport } from "../src/index.ts";
import { formatDoctor } from "../src/cli/format-doctor.ts";
import { FAKE_SECRETS, fakeToolsDir, installFakeTool, pathWithFakes } from "./helpers/fake-tools.ts";
import { isRunning, until } from "./helpers/process.ts";
import { removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const SECRETS_ON_STDOUT = `console.log(JSON.stringify({ loggedIn: true, email: ${JSON.stringify(FAKE_SECRETS[0])}, token: ${JSON.stringify(FAKE_SECRETS[1])} }));`;

/** Fake versions of the three tools, each as a tool would answer, with credentials in what its status command prints. */
function installAll(dir: string, log: string, overrides: Partial<Record<"claude" | "codex" | "opencode", string>> = {}) {
  installFakeTool(
    dir,
    log,
    "claude",
    overrides.claude ?? `if (argv[0] === "--version") console.log("2.0.1 (Claude Code)"); else { ${SECRETS_ON_STDOUT} }`,
  );
  installFakeTool(
    dir,
    log,
    "codex",
    overrides.codex ??
      `if (argv[0] === "--version") console.log("codex-cli 0.9.0"); else { console.log("Logged out; was ${FAKE_SECRETS[0]} ${FAKE_SECRETS[1]}"); process.exitCode = 1; }`,
  );
  installFakeTool(
    dir,
    log,
    "opencode",
    overrides.opencode ?? `if (argv[0] === "--version") console.log("1.2.3"); else { console.log("credentials: ${FAKE_SECRETS[1]}"); }`,
  );
}

const toolOf = (report: DoctorReport, id: string) => report.tools.find((tool) => tool.id === id)!;

describe("diagnose: the tools", () => {
  it("reports each tool as installed or not, its version, and its login only as its own status command says", async () => {
    const { dir, log, invocations } = fakeToolsDir();
    installAll(dir, log);

    const report = await diagnose({ env: await pathWithFakes(dir) });

    expect(toolOf(report, "claude-code")).toMatchObject({ installed: true, version: "2.0.1 (Claude Code)", login: { state: "logged_in" } });
    expect(toolOf(report, "codex")).toMatchObject({ installed: true, version: "codex-cli 0.9.0", login: { state: "not_logged_in" } });
    // OpenCode's only status command prints credentials as free text, so it is never run.
    expect(toolOf(report, "opencode")).toMatchObject({ installed: true, version: "1.2.3", login: { state: "unknown" } });
    expect(invocations().filter((call) => call.tool === "opencode").map((call) => call.argv)).toEqual([["--version"]]);
  });

  it("reports a tool that is not on PATH as not installed, with no version", async () => {
    const { dir, log } = fakeToolsDir();
    installFakeTool(dir, log, "claude", `console.log("2.0.1 (Claude Code)");`);

    const report = await diagnose({ env: await pathWithFakes(dir) });

    expect(toolOf(report, "opencode")).toMatchObject({ installed: false, version: null, login: { state: "unknown" }, usable: false });
    expect(toolOf(report, "opencode").problem).toMatch(/"opencode" is not on PATH/);
  });

  it("never prints or returns a credential a tool's status command printed", async () => {
    const { dir, log } = fakeToolsDir();
    installAll(dir, log);

    const report = await diagnose({ env: await pathWithFakes(dir) });

    for (const text of [JSON.stringify(report), formatDoctor(report)]) {
      for (const secret of FAKE_SECRETS) expect(text).not.toContain(secret);
    }
  });

  it("only ever runs version and login-status commands, with nothing on stdin and never a prompt", async () => {
    const { dir, log, invocations } = fakeToolsDir();
    installAll(dir, log);

    await diagnose({ env: await pathWithFakes(dir) });

    const allowed = ["--version", "auth status --json", "login status"];
    const calls = invocations();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(allowed).toContain(call.argv.join(" "));
      expect(call.stdinBytes).toBe(0);
    }
  });

  it("reports a login whose status it cannot read as unknown rather than guessing", async () => {
    const { dir, log } = fakeToolsDir();
    installAll(dir, log, {
      claude: `if (argv[0] === "--version") console.log("2.0.1"); else console.log("not json at all");`,
      codex: `if (argv[0] === "--version") console.log("0.9.0"); else process.exitCode = 3;`,
    });

    const report = await diagnose({ env: await pathWithFakes(dir) });

    expect(toolOf(report, "claude-code").login.state).toBe("unknown");
    expect(toolOf(report, "codex").login.state).toBe("unknown");
    expect(toolOf(report, "codex").login.detail).toContain("exited with code 3");
  });

  it("stops a tool that does not answer in time, reports it, and leaves no process behind", async () => {
    const { dir, log } = fakeToolsDir();
    const pidFile = join(dir, "hung.pid");
    installAll(dir, log, {
      claude: `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    });

    const report = await diagnose({ env: await pathWithFakes(dir), timeoutMs: 1500 });

    const claude = toolOf(report, "claude-code");
    expect(claude).toMatchObject({ installed: true, version: null, login: { state: "unknown" } });
    expect(claude.problem).toMatch(/did not finish within 1500 ms and stopped/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await until(() => (isRunning(pid) ? undefined : true), "the hung tool to be gone");
    expect(toolOf(report, "codex").version).toBe("codex-cli 0.9.0");
  });
});

describe("diagnose: capabilities", () => {
  const withDeclaration = (name: string): Adapter => ({
    ...mockAdapter,
    declaration: {
      ...mockAdapter.declaration,
      name,
      mock: false,
      transport: "acp",
      capabilities: {
        ...mockAdapter.declaration.capabilities,
        read_only: { win32: "none", darwin: "cooperative", linux: "enforced_by_tool" },
      },
    },
  });

  it("shows the levels an installed tool's adapter declares for the system, and a tool with no adapter as having none", async () => {
    const { dir, log } = fakeToolsDir();
    installAll(dir, log);
    const adapters = new Map([["codex", withDeclaration("codex")]]);
    const env = await pathWithFakes(dir);

    const onLinux = await diagnose({ env, platform: "linux", adapters });
    const onWindows = await diagnose({ env, platform: "win32", adapters });

    expect(toolOf(onLinux, "codex").adapter?.capabilities).toContainEqual({ kind: "read_only", level: "enforced_by_tool" });
    expect(toolOf(onWindows, "codex").adapter?.capabilities).toContainEqual({ kind: "read_only", level: "none" });
    expect(toolOf(onLinux, "codex").adapter).toMatchObject({ name: "codex", transport: "acp" });
    expect(toolOf(onLinux, "claude-code").adapter).toBeNull();
    expect(formatDoctor(onLinux)).toContain("read_only: enforced_by_tool");
    expect(formatDoctor(onLinux)).toContain("none in this build yet");
  });

  it("counts a tool as usable only when it is installed, has an adapter, and is not known to be logged out", async () => {
    const { dir, log } = fakeToolsDir();
    installAll(dir, log);
    const adapters = new Map(["claude", "codex", "opencode"].map((name) => [{ claude: "claude-code" }[name] ?? name, withDeclaration(name)] as const));

    const report = await diagnose({ env: await pathWithFakes(dir), adapters });

    expect(report.tools.map((tool) => [tool.id, tool.usable])).toEqual([
      ["claude-code", true],
      ["codex", false], // logged out
      ["opencode", true], // login unknown
    ]);
  });
});

describe("diagnose: the system", () => {
  it("reports Node and git against their requirements, and fails the report when one is too old", async () => {
    const { dir, log } = fakeToolsDir();
    installAll(dir, log);
    installFakeTool(dir, log, "git", `console.log("git version 2.19.1");`);
    const env = { PATH: dir, Path: dir };

    const old = await diagnose({ env, nodeVersion: "22.4.0" });
    expect(old.system.node).toEqual({ version: "22.4.0", required: "24 or newer", meets: false });
    expect(old.system.git).toMatchObject({ version: "2.19.1", required: "2.20 or newer", meets: false });
    expect(old.ok).toBe(false);

    const current = await diagnose({ env: await pathWithFakes((fakeToolsDir()).dir) });
    expect(current.system.node.meets).toBe(true);
    expect(current.system.git.meets).toBe(true);
    // Not one tool installed, and the report is still fine.
    expect(current.tools.every((tool) => !tool.installed)).toBe(true);
    expect(current.ok).toBe(true);
  });

  it("reports git that is not installed as a problem", async () => {
    const { dir } = fakeToolsDir();

    const report = await diagnose({ env: { PATH: dir, Path: dir } });

    expect(report.system.git).toMatchObject({ version: null, meets: false });
    expect(report.system.git.detail).toMatch(/"git" is not on PATH/);
    expect(report.ok).toBe(false);
  });

  it("labels the system, and says plainly that one without a support-matrix label is not supported", async () => {
    const { dir } = fakeToolsDir();
    const env = await pathWithFakes(dir);

    expect((await diagnose({ env, platform: "darwin" })).system.os).toMatchObject({ label: "macOS", supported: true });
    expect((await diagnose({ env, platform: "freebsd" })).system.os).toMatchObject({ label: null, supported: false });
  });
});
