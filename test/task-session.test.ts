import { describe, expect, it } from "vitest";
import { afterRun, applySlash, CHANGED_HERE, draftTask, freshSession, sessionCasting, sessionChanges, toolNamed, type SlashContext, type TaskSession } from "../src/commands/task.ts";
import { castRoles } from "../src/setup/infer.ts";
import { CHECK_TYPED } from "../src/setup/task.ts";
import { reportOf } from "./helpers/report.ts";

const READY = reportOf({ "claude-code": "ready", codex: "ready", opencode: "missing" });
const base = castRoles(READY);

function context(session: TaskSession = freshSession(), overrides: Partial<SlashContext> = {}): SlashContext {
  return { session, base, report: READY, remotes: ["origin"], ...overrides };
}

const ok = (name: string, argument: string, given = context()) => {
  const outcome = applySlash(name, argument, given);
  if (!outcome.ok) throw new Error(`refused: ${outcome.error}`);
  return outcome;
};
const refused = (name: string, argument: string, given = context()) => {
  const outcome = applySlash(name, argument, given);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome.error;
};

describe("the casting", () => {
  it("casts the reference scenario, with opencode (missing) replaced by the first usable tool", () => {
    expect(base.map((a) => `${a.role}:${a.tool}`)).toEqual(["plan:claude-code", "implement:codex", "review:claude-code"]);
  });

  it("puts the session's changes on top, and the mock over every role when chosen", () => {
    const changed = ok("model", "implement claude sonnet").session;
    expect(sessionCasting(base, changed).map((a) => `${a.role}:${a.tool}:${a.model ?? ""}`)).toEqual(["plan:claude-code:", "implement:claude-code:sonnet", "review:claude-code:"]);
    expect(sessionCasting(base, { ...changed, mock: true }).every((a) => a.tool === null && a.adapter === "mock")).toBe(true);
  });
});

describe("/model", () => {
  it("sets a step's tool and model, the way the ticket writes it", () => {
    const { session, notice } = ok("model", "implement codex gpt-5.6");
    expect(session.steps.implement).toEqual({ role: "implement", adapter: "codex", tool: "codex", reason: CHANGED_HERE, model: "gpt-5.6" });
    expect(notice).toBe("implement: Codex CLI, gpt-5.6 for the next run");
  });

  it("takes a model with spaces, `claude` for Claude Code, and keeps the tool when only a model is named", () => {
    expect(ok("model", "review claude my model name").session.steps.review).toMatchObject({ tool: "claude-code", model: "my model name" });
    const kept = ok("model", "implement gpt-5.7").session.steps.implement;
    expect(kept).toMatchObject({ tool: "codex", model: "gpt-5.7", reason: CHANGED_HERE });
  });

  it("drops the model and effort of the old tool when the tool changes, and keeps the effort for the same tool", () => {
    const withEffort = ok("effort", "implement high").session;
    expect(withEffort.steps.implement?.effort).toBe("high");
    expect(ok("model", "implement claude", context(withEffort)).session.steps.implement?.effort).toBeUndefined();
    expect(ok("model", "implement codex gpt-5.7", context(withEffort)).session.steps.implement).toMatchObject({ model: "gpt-5.7", effort: "high" });
  });

  it("refuses an unknown step, a missing tool, a tool not usable here, and the mock", () => {
    expect(refused("model", "")).toMatch(/^usage: \/model <step> <tool> \[model\]/);
    expect(refused("model", "ship codex")).toMatch(/^usage: /);
    expect(refused("model", "implement")).toMatch(/^usage: /);
    expect(refused("model", "review opencode")).toBe("review opencode: OpenCode is not usable here (not installed; /tools says more)");
    expect(refused("model", "plan codex", context({ ...freshSession(), mock: true }))).toMatch(/the mock plays every step/);
  });
});

describe("/effort", () => {
  it("sets an effort the step's tool has, and `default` clears it", () => {
    const set = ok("effort", "review high").session;
    expect(set.steps.review).toMatchObject({ tool: "claude-code", effort: "high", reason: CHANGED_HERE });
    expect(ok("effort", "review default", context(set)).session.steps.review?.effort).toBeUndefined();
  });

  it("refuses a level the tool does not have, and a tool with no effort", () => {
    expect(refused("effort", "implement turbo")).toMatch(/^implement effort turbo: Codex CLI's efforts are /);
    const opencode = reportOf({ "claude-code": "missing", codex: "missing", opencode: "ready" });
    expect(refused("effort", "plan high", context(freshSession(), { base: castRoles(opencode), report: opencode }))).toBe("OpenCode has no effort setting");
    expect(refused("effort", "plan")).toMatch(/^usage: \/effort/);
  });
});

describe("/plan, /check and /push", () => {
  it("/plan sets, and toggles with no word", () => {
    expect(ok("plan", "on").session.plan).toBe(true);
    expect(ok("plan", "off", context({ ...freshSession(), plan: true })).session.plan).toBe(false);
    expect(ok("plan", "", context({ ...freshSession(), plan: true })).session.plan).toBe(false);
    expect(refused("plan", "maybe")).toBe("usage: /plan on or /plan off");
  });

  it("/check takes the rest of the line as the command, or none", () => {
    expect(ok("check", "node check.mjs --fast").session.check).toEqual({ command: "node check.mjs --fast", source: CHECK_TYPED });
    expect(ok("check", "none").session.check).toBe("none");
    expect(refused("check", "")).toMatch(/^usage: \/check/);
  });

  it("/push names a remote the repository has, or `.` for a branch here", () => {
    expect(ok("push", "origin").session.remote).toBe("origin");
    expect(ok("push", ".", context({ ...freshSession(), remote: "origin" })).session.remote).toBeNull();
    expect(refused("push", "upstream")).toBe('this repository has no remote "upstream" (it has origin): `git remote add upstream <url>` adds it, or /push . keeps the branch here');
    expect(refused("push", "")).toMatch(/^usage: \/push/);
    expect(refused("push", "a b")).toMatch(/^usage: \/push/);
  });

  it("says what changed for the status line, and forgets it after a run starts, keeping the mock", () => {
    let session = ok("model", "implement codex gpt-5.6").session;
    session = ok("plan", "on", context(session)).session;
    session = ok("check", "npm test", context(session)).session;
    session = ok("push", "origin", context(session)).session;
    expect(sessionChanges(session)).toEqual(["plan on", "implement Codex CLI gpt-5.6", "check npm test", "push origin"]);
    expect(sessionChanges(afterRun({ ...session, mock: true }))).toEqual([]);
    expect(afterRun({ ...session, mock: true }).mock).toBe(true);
  });
});

describe("toolNamed", () => {
  it("knows the ids and claude", () => {
    expect([toolNamed("codex"), toolNamed("Claude"), toolNamed("claude-code"), toolNamed("opencode"), toolNamed("gpt-5.6")]).toEqual(["codex", "claude-code", "claude-code", "opencode", null]);
  });
});

describe("draftTask", () => {
  const found = { check: { command: "npm test", source: "package.json" }, install: { command: "npm ci", source: "package-lock.json" } };
  const input = (session = freshSession(), over: Partial<Parameters<typeof draftTask>[0]> = {}) => ({ task: "fix the cart total", found, base, session, branches: [] as string[], ...over });

  it("is implement then review with the project's check and install, and a branch here", () => {
    const { run, needsCheck, noTool } = draftTask(input());
    expect(run.assignments.map((a) => a.role)).toEqual(["implement", "review"]);
    expect(run.check).toEqual(found.check);
    expect(run.install).toEqual(found.install);
    expect(run.branch).toBe("ahp/fix-the-cart-total");
    expect(run.remote).toBe(".");
    expect([needsCheck, noTool]).toEqual([false, false]);
  });

  it("adds the plan step first, numbers a taken branch, and aims at the remote chosen", () => {
    const { run } = draftTask(input({ ...freshSession(), plan: true, remote: "origin" }, { branches: ["ahp/fix-the-cart-total"] }));
    expect(run.assignments.map((a) => a.role)).toEqual(["plan", "implement", "review"]);
    expect(run.branch).toBe("ahp/fix-the-cart-total-2");
    expect(run.remote).toBe("origin");
  });

  it("asks for a check when the project names none, and has no install without a check", () => {
    const none = { check: null, install: found.install };
    expect(draftTask(input(freshSession(), { found: none })).needsCheck).toBe(true);
    const typed = draftTask(input({ ...freshSession(), check: { command: "node check.mjs", source: CHECK_TYPED } }, { found: none }));
    expect(typed.needsCheck).toBe(false);
    expect(typed.run.check?.command).toBe("node check.mjs");
    const reviewOnly = draftTask(input({ ...freshSession(), check: "none" }, { found: none }));
    expect(reviewOnly.needsCheck).toBe(false);
    expect(reviewOnly.run.check).toBeNull();
    expect(reviewOnly.run.install).toBeNull();
  });

  it("is `noTool` when no tool is usable and the mock was not chosen, never silently the mock", () => {
    const nothing = reportOf({ "claude-code": "missing", codex: "logged_out", opencode: "missing" });
    const bare = castRoles(nothing);
    expect(bare.every((a) => a.tool === null)).toBe(true);
    expect(draftTask(input(freshSession(), { base: bare })).noTool).toBe(true);
    const mocked = draftTask(input(freshSession(true), { base: bare }));
    expect(mocked.noTool).toBe(false);
    expect(mocked.run.assignments.every((a) => a.adapter === "mock")).toBe(true);
  });
});
