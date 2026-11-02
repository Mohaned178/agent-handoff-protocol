import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRuns, runWorkflow } from "../src/index.ts";
import { settingsPath } from "../src/runtime/paths.ts";
import { markFirstOpenDone, readSettings } from "../src/setup/settings.ts";
import type { Precheck } from "../src/setup/precheck.ts";
import { TaskRunner } from "../src/tui/task-runner.ts";
import { addBareRemote } from "./helpers/external.ts";
import { createTempRepo, git, removeTempRepos } from "./helpers/repo.ts";
import { hello, retryWorkflow } from "./helpers/retry.ts";
import { colorAt } from "./helpers/tui.ts";
import { closeApps, forgetSettings, openApp, toolsEnv, type FakeTools } from "./helpers/tui-app.ts";

const TASK = "fix the cart total";
const SLUG = "ahp/fix-the-cart-total";

let repo: string;
const runners: TaskRunner[] = [];

beforeEach(async () => {
  forgetSettings();
  await markFirstOpenDone(settingsPath());
  repo = createTempRepo({ "README.md": "# app\n", "check.mjs": "process.exit(0);\n", "red.mjs": "process.exit(1);\n" });
});
afterEach(async () => {
  // A run still going has an agent behind it: stop it through its signal before the repository goes.
  for (const runner of runners.splice(0)) {
    runner.cancel();
    await runner.settled();
  }
  closeApps();
  removeTempRepos();
});

/** Polls until  holds. */
async function until(test: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const saved = async () => (await readSettings(settingsPath())).settings;
const lastLine = (frame: string) => frame.split("\n").filter((line) => line.trim() !== "").at(-1)!.trim();

/** A runner whose run holds its agent until it is cancelled, whatever workflow it is given: the cancel tests need a run that goes on. */
function holdingRunner(): TaskRunner {
  const runner = new TaskRunner({ run: (_workflow, options) => runWorkflow(retryWorkflow([{ ...hello, hang: true }]), options), cancelGraceMs: 500 });
  runners.push(runner);
  return runner;
}

async function app(tools: FakeTools, options: Partial<Parameters<typeof openApp>[0]> = {}) {
  const env = await toolsEnv(tools);
  const opened = openApp({ repo, env, ...options });
  await opened.tui.waitFor("No runs here yet.");
  return opened;
}

const READY: FakeTools = { claude: "ready", codex: "ready", opencode: "ready" };
const MOCK_ONLY: FakeTools = {};

/** Types a task and waits for its summary. */
async function summaryOf(tui: Awaited<ReturnType<typeof app>>["tui"], task: string, waitFor: string) {
  await tui.type(task);
  await tui.press("enter");
  return tui.waitFor(waitFor);
}

describe("a task, from the prompt to a run", () => {
  it("runs on the mock when no tool is usable: the summary says so, asks for the check, and the run screen opens on a run marked mock", async () => {
    const { tui } = await app(MOCK_ONLY);

    let frame = await summaryOf(tui, TASK, "No coding tool is usable here");
    expect(frame).toContain("Install one and log in with your own account");
    expect(frame).toContain("Or try the flow on the scripted mock: m");
    // Nothing runs until it is asked for: the footer offers the mock, not a run.
    expect(lastLine(frame)).not.toContain("enter run");
    await tui.type("m");
    frame = await tui.waitFor("! mock: scripted agents show the flow");
    expect(frame).toMatch(/implement +mock +scripted, not a real agent/);
    expect(frame).toMatch(/review +mock +scripted, not a real agent/);
    expect(frame.split("\n")[0]).toMatch(/^ AHP {2}summary · mock/);

    // The repository names no check: it is asked for in place.
    expect(frame).toMatch(/check +none found +no test script, pytest, cargo, go or make test target/);
    expect(frame).toContain("What checks this work? t type a command, n none");
    await tui.type("t");
    await tui.waitFor("The command that checks the work");
    await tui.type("node check.mjs");
    await tui.press("enter");
    frame = await tui.waitFor("typed by you");
    expect(frame).toMatch(/check +node check\.mjs +typed by you/);
    expect(frame).toMatch(/result +branch ahp\/fix-the-cart-total, local, after you approve/);
    expect(lastLine(frame)).toContain("enter run");
    expect(await listRuns({ repo })).toEqual([]);

    await tui.press("enter");
    // The run screen opens on the run this process started; the mock's steps are checked, then it waits for the person.
    frame = await tui.waitFor("waiting for your approval", 60_000);
    const [listed] = await listRuns({ repo });
    expect(listed?.state?.workflowName).toBe("fix-the-cart-total");
    expect(listed?.state?.mock).toBe(true);
    expect(frame.split("\n")[0]).toMatch(new RegExp(`^ AHP {2}run ${listed!.runId} · fix-the-cart-total · .*mock`));
    expect(frame).toMatch(/✓ implement {2}mock/);
    expect(frame).toContain("mock (scripted, not evidence)");

    // Esc leaves it on the list, still the mock's, waiting for the person.
    await tui.press("escape");
    frame = await tui.waitFor("Waiting for you");
    expect(frame).toMatch(/! fix-the-cart-total +.* +waiting for your approval at approve · mock/);
    expect((await listRuns({ repo }))[0]?.state?.state).toBe("waiting_approval");
    // The changes were for that run; the mock stays chosen for the session.
    expect(lastLine(frame)).toContain("mock plays every step");
    expect(git(repo, "status", "--porcelain")).toBe("");
  }, 120_000);

  it("shows what it worked out, every answer with where it came from", async () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", scripts: { test: "node check.mjs" } }));
    writeFileSync(join(repo, "package-lock.json"), "{}");
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "--message", "a project");
    writeFileSync(join(repo, "README.md"), "# changed\n");
    writeFileSync(join(repo, "new.txt"), "x\n");
    const { tui } = await app({ claude: "ready", codex: "ready" });

    const frame = await summaryOf(tui, TASK, "result");
    expect(frame.split("\n")[0]).toMatch(/^ AHP {2}summary/);
    expect(frame).toContain(TASK);
    expect(frame).toMatch(/check +npm test +package\.json/);
    expect(frame).toMatch(/install +npm ci +package-lock\.json/);
    // implement is Codex (preferred), review would be OpenCode (missing): Claude Code, the first usable tool.
    expect(frame).toMatch(/implement +Codex CLI · default model +installed here/);
    expect(frame).toMatch(/review +Claude Code · default model +installed here/);
    expect(frame).not.toMatch(/\n +plan /);
    expect(frame).toMatch(/result +branch ahp\/fix-the-cart-total, local, after you approve/);
    expect(frame).toContain("2 files not committed: the agents will not see them");
    expect(frame).toContain("! first run with real agents: they run commands on this machine, and their usage counts against your own plans");
    expect(colorAt(tui.raw(), "installed here")).toContain("muted");
    expect(lastLine(frame)).toBe("enter run  tab change a step  p add a plan step  w save as workflow  esc edit  ctrl+c quit");
    expect(await listRuns({ repo })).toEqual([]);
  });

  it("numbers the branch when its name is taken, and adds or removes the plan step with p", async () => {
    git(repo, "branch", SLUG);
    const { tui } = await app({ claude: "ready", codex: "ready" });
    await tui.type("/check node check.mjs");
    await tui.press("enter");
    await tui.waitFor("the next run is checked by `node check.mjs`");

    let frame = await summaryOf(tui, TASK, "result");
    expect(frame).toContain("branch ahp/fix-the-cart-total-2, local, after you approve");
    await tui.type("p");
    frame = tui.frame();
    expect(frame).toMatch(/plan +Claude Code · default model/);
    expect(frame.indexOf("plan ")).toBeLessThan(frame.indexOf("implement "));
    expect(lastLine(frame)).toContain("p remove the plan step");
    await tui.type("p");
    expect(tui.frame()).not.toMatch(/\n +plan /);
  });

  it("asks for a check in place: none means review only, labelled not verified", async () => {
    const { tui } = await app(READY);
    let frame = await summaryOf(tui, TASK, "What checks this work?");
    expect(lastLine(frame)).not.toContain("enter run");
    await tui.type("n");
    frame = tui.frame();
    expect(frame).toMatch(/check +none: review only +not verified/);
    expect(colorAt(tui.raw(), "not verified")).toContain("warn");
    expect(lastLine(frame)).toContain("enter run");
  });

  it("Esc on the summary brings the task back into the prompt", async () => {
    const { tui } = await app(READY);
    await summaryOf(tui, TASK, "What checks this work?");
    await tui.press("escape");
    await tui.waitFor("No runs here yet.");
    expect(tui.frame()).toContain(`❯ ${TASK}`);
  });
});

describe("choosing per step", () => {
  /** Opens the summary of a task whose check is given, with implement picked. */
  async function pickedImplement(tools: FakeTools) {
    const opened = await app(tools);
    await opened.tui.type("/check node check.mjs");
    await opened.tui.press("enter");
    await opened.tui.waitFor("the next run is checked by");
    await summaryOf(opened.tui, TASK, "result");
    await opened.tui.press("tab");
    expect(opened.tui.frame()).toMatch(/❯ implement/);
    expect(lastLine(opened.tui.frame())).toContain("enter change implement");
    return opened;
  }

  it("Tab picks a step, Enter opens its tool, model and effort, and 'next time' defaults to no: nothing is saved", async () => {
    const { tui } = await pickedImplement(READY);
    await tui.press("enter");
    await tui.waitFor("Who does implement?");
    await tui.type("claude");
    await tui.press("enter");
    await tui.waitFor("Which model for implement? (Claude Code)");
    expect(tui.frame()).toContain("from Claude Code's aliases");
    await tui.type("opus");
    await tui.press("enter");
    await tui.waitFor("Which effort for implement?");
    await tui.type("high");
    await tui.press("enter");
    const question = await tui.waitFor("next time?");
    expect(question).toContain("Use Claude Code (opus, effort high) for implement next time?");
    expect(question).toMatch(/❯ no, only this run/);
    await tui.press("enter");

    const frame = await tui.waitFor("you changed it");
    expect(frame).toMatch(/implement +Claude Code · opus · high +you changed it/);
    expect(frame).toMatch(/review +OpenCode · default model +installed here/);
    expect((await saved()).steps).toEqual({});
  });

  it("saves the step as the default when told to, and the summary then calls it your default", async () => {
    const { tui } = await pickedImplement(READY);
    await tui.press("enter");
    await tui.waitFor("Who does implement?");
    await tui.type("claude");
    await tui.press("enter");
    await tui.waitFor("Which model for implement?");
    await tui.type("sonnet");
    await tui.press("enter");
    await tui.waitFor("Which effort for implement?");
    await tui.press("enter");
    await tui.waitFor("next time?");
    await tui.press("down", "enter");

    const frame = await tui.waitFor("your default");
    expect(frame).toMatch(/implement +Claude Code · sonnet +your default/);
    expect((await saved()).steps).toEqual({ implement: { tool: "claude-code", model: "sonnet" } });
    // The first-open flag survives the save.
    expect((await saved()).firstOpenDone).toBe(true);
  });

  it("takes a model name that is typed, and Esc leaves the step as it was", async () => {
    const { tui } = await pickedImplement(READY);
    await tui.press("enter");
    await tui.waitFor("Who does implement?");
    await tui.type("codex");
    await tui.press("enter");
    await tui.waitFor("Which model for implement? (Codex CLI)");
    await tui.type("type a model");
    await tui.press("enter");
    await tui.type("gpt-5.6-test");
    expect(tui.frame()).toContain("gpt-5.6-test");
    await tui.press("enter");
    await tui.waitFor("Which effort for implement?");
    await tui.press("enter");
    await tui.waitFor("next time?");
    await tui.press("enter");
    expect((await tui.waitFor("you changed it"))).toMatch(/implement +Codex CLI · gpt-5.6-test +you changed it/);

    await tui.press("enter");
    await tui.waitFor("Who does implement?");
    await tui.press("escape");
    expect(tui.frame()).toMatch(/implement +Codex CLI · gpt-5.6-test +you changed it/);
  });

  it("asks which OpenCode access you have once, never claiming to have checked it, and offers only the models that access has", async () => {
    const { tui } = await pickedImplement({ ...READY, models: ["opencode/big-pickle-free", "openai/gpt-x", "opencode-go/kimi"] });
    await tui.press("enter");
    await tui.waitFor("Who does implement?");
    await tui.type("opencode");
    await tui.press("enter");
    const access = await tui.waitFor("Which OpenCode access do you have?");
    expect(access).toContain("AHP cannot check it");
    expect(access).toContain("[ ] OpenCode Zen, paid (a Zen balance)");
    await tui.press("enter");

    const models = await tui.waitFor("big-pickle-free");
    expect(models).toContain("from `opencode models`");
    expect(models).not.toContain("openai/gpt-x");
    expect(models).not.toContain("kimi");
    await tui.press("enter");
    // OpenCode has no effort setting, so the next question is the last.
    await tui.waitFor("next time?");
    await tui.press("enter");
    await tui.waitFor("you changed it");

    // Review, also OpenCode: no second access question.
    await tui.press("tab");
    expect(tui.frame()).toMatch(/❯ review/);
    await tui.press("enter");
    await tui.waitFor("Who does review?");
    await tui.type("opencode");
    await tui.press("enter");
    const next = await tui.waitFor("Which model for review? (OpenCode)");
    expect(next).not.toContain("Which OpenCode access do you have?");
  });
});

describe("the same from the prompt", () => {
  it("/model, /effort, /plan, /check and /push change the next run and say so, then a task shows them", async () => {
    addBareRemote(repo);
    const { tui } = await app({ claude: "ready", codex: "ready" });

    await tui.type("/model implement codex gpt-5.6");
    await tui.press("enter");
    let frame = await tui.waitFor("implement: Codex CLI, gpt-5.6 for the next run");
    expect(lastLine(frame)).toMatch(/^next run: implement Codex CLI gpt-5.6/);
    await tui.type("/effort review high");
    await tui.press("enter");
    await tui.waitFor("review: Claude Code, default model, effort high for the next run");
    await tui.type("/plan on");
    await tui.press("enter");
    await tui.waitFor("the plan step is on for the next run");
    await tui.type("/check node check.mjs");
    await tui.press("enter");
    await tui.waitFor("the next run is checked by `node check.mjs`");
    await tui.type("/push origin");
    await tui.press("enter");
    frame = await tui.waitFor("pushes the approved branch to origin, after you approve");
    // The status line is cut at the right when it is long, so what changed comes first.
    expect(lastLine(frame)).toMatch(/^next run: plan on, implement Codex CLI gpt-5\.6, review Claude Code high,/);
    expect(colorAt(tui.raw(), "pushes the approved")).toContain("text");

    frame = await summaryOf(tui, TASK, "pushed to origin");
    expect(frame).toMatch(/plan +Claude Code · default model/);
    expect(frame).toMatch(/implement +Codex CLI · gpt-5\.6 +you changed it/);
    expect(frame).toMatch(/review +Claude Code · default model · high +you changed it/);
    expect(frame).toMatch(/check +node check\.mjs +typed by you/);
    expect(frame).toContain("branch ahp/fix-the-cart-total, pushed to origin once you approve");

    // Nothing started, so they still wait for the next run (they are forgotten once a run starts, see the mock test).
    await tui.press("escape");
    await tui.waitFor("No runs here yet.");
    expect(tui.frame()).toContain("next run:");
  });

  it("refuses with a sentence that says how to write it right, in the error colour", async () => {
    const { tui } = await app({ claude: "ready", codex: "ready" });
    const refuse = async (line: string, text: string) => {
      await tui.type(line);
      await tui.press("enter");
      const frame = await tui.waitFor(text);
      expect(colorAt(tui.raw(), text)).toContain("error");
      return frame;
    };
    await refuse("/effort implement turbo", "implement effort turbo: Codex CLI's efforts are minimal, low, medium, high, xhigh");
    await refuse("/model implement opencode", "implement opencode: OpenCode is not usable here (not installed; /tools says more)");
    await refuse("/model ship codex", "usage: /model <step> <tool> [model]");
    await refuse("/push upstream", 'this repository has no remote "upstream"');
    await refuse("/plan maybe", "usage: /plan on or /plan off");
    await refuse("/nothing", "No command /nothing: type / to see them.");
    expect(tui.frame()).not.toContain("next run:");
  });
});

describe("before the run starts", () => {
  it("says when the check already fails on the last commit; Esc goes back and starts nothing, Enter runs anyway", async () => {
    const { tui } = await app(MOCK_ONLY);
    await tui.type("/check node red.mjs");
    await tui.press("enter");
    await tui.waitFor("the next run is checked by `node red.mjs`");
    await summaryOf(tui, TASK, "No coding tool is usable here");
    await tui.type("m");
    await tui.waitFor("! mock:");

    await tui.press("enter");
    let frame = await tui.waitFor("already fails on your last commit");
    expect(frame).toContain("! `node red.mjs` already fails on your last commit:");
    expect(frame).toContain("The agents are asked to make it pass. enter runs it anyway, esc goes back.");
    expect(lastLine(frame)).toBe("enter run anyway  esc back");
    expect(colorAt(tui.raw(), "! `node red.mjs`")).toContain("warn");
    await tui.press("escape");
    frame = tui.frame();
    expect(frame).not.toContain("already fails");
    expect(await listRuns({ repo })).toEqual([]);

    await tui.press("enter");
    await tui.waitFor("already fails on your last commit");
    await tui.press("enter");
    // Run anyway: the mock's implement step is checked by the failing check, and fails by it.
    await tui.waitFor("Receipt", 90_000);
    const [listed] = await listRuns({ repo });
    expect(listed?.state?.state).toBe("failed");
  }, 150_000);

  it("drops the answer of a check the person has left: the run is not started late", async () => {
    let finish!: (result: Precheck) => void;
    const slow = new Promise<Precheck>((resolve) => (finish = resolve));
    const { tui } = await app(MOCK_ONLY, { tasks: (given) => ({ ...given, precheck: () => slow }) });
    await tui.type("/check node check.mjs");
    await tui.press("enter");
    await tui.waitFor("the next run is checked by");
    await summaryOf(tui, TASK, "No coding tool is usable here");
    await tui.type("m");
    await tui.waitFor("! mock:");
    await tui.press("enter");
    await tui.waitFor("checking `node check.mjs` on your last commit");
    expect(lastLine(tui.frame())).toBe("esc stop checking");
    await tui.press("escape");
    expect(tui.frame()).not.toContain("checking `node check.mjs`");
    finish({ passed: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tui.frame()).toContain("summary");
    expect(await listRuns({ repo })).toEqual([]);
  });

  it("says the real-agents notice once: it is on the first summary and not on the next", async () => {
    const runner = holdingRunner();
    const { tui } = await app(READY, { runner });
    await tui.type("/check node check.mjs");
    await tui.press("enter");
    await tui.waitFor("the next run is checked by");
    let frame = await summaryOf(tui, TASK, "result");
    expect(frame).toContain("! first run with real agents");
    await tui.press("enter");
    await tui.waitFor((text) => /run run_\w+ · /.test(text), 60_000);
    await until(async () => (await saved()).realAgentsNoticed === true);
    runner.cancel();
    await runner.settled();
    await tui.press("escape");
    await tui.waitFor("Recent");
    await tui.type("/check node check.mjs");
    await tui.press("enter");
    await tui.waitFor("the next run is checked by");
    frame = await summaryOf(tui, "another task", "result");
    expect(frame).not.toContain("first run with real agents");
  }, 120_000);
});

describe("a run going, cancelled and quit", () => {
  /** A run started from the prompt and held, with its run screen open. */
  async function startedRun() {
    const runner = holdingRunner();
    const { tui } = await app(MOCK_ONLY, { runner });
    await tui.type("/check node check.mjs");
    await tui.press("enter");
    await tui.waitFor("the next run is checked by");
    await summaryOf(tui, TASK, "No coding tool is usable here");
    await tui.type("m");
    await tui.waitFor("! mock:");
    await tui.press("enter");
    const frame = await tui.waitFor((text) => /run run_\w+ · /.test(text) && text.includes("implement"), 60_000);
    return { tui, runner, frame, runId: /run (run_\w+) · /.exec(frame)![1]! };
  }

  it("ctrl+c on the run screen asks 'Cancel the run? y/n'; n goes on, y records the cancel through the run's signal", async () => {
    const { tui, runner, frame, runId } = await startedRun();
    expect(lastLine(frame)).toContain("ctrl+c cancel");

    await tui.press("ctrl+c");
    let asked = await tui.waitFor("Cancel the run? y/n");
    expect(lastLine(asked)).toBe("y yes  n no");
    await tui.type("n");
    await tui.waitFor("implement");
    expect(runner.going()).toBe(true);

    await tui.press("ctrl+c");
    await tui.waitFor("Cancel the run? y/n");
    await tui.type("y");
    await runner.settled();
    asked = await tui.waitFor("cancelled");
    const [listed] = await listRuns({ repo });
    expect(listed?.runId).toBe(runId);
    expect(listed?.state?.state).toBe("cancelled");
    expect(tui.exited()).toBe(false);
  }, 120_000);

  it("esc goes home with the run still going, shown at the top with its spinner; enter opens it again", async () => {
    const { tui, runner, runId } = await startedRun();
    await tui.press("escape");
    const home = await tui.waitFor("enter opens it");
    expect(home).toMatch(new RegExp(`running +run ${runId.replace(/^run_/, "")} +fix-the-cart-total · mock`));
    expect(runner.going()).toBe(true);
    // Shown once: not also under Recent or Waiting.
    expect(home.split(runId.replace(/^run_/, "")).length - 1).toBe(1);
    expect(lastLine(home)).toContain("enter open the run");
    // A second task waits for this one.
    await tui.type("another task");
    await tui.press("enter");
    await tui.waitFor("A run is going in this window");
    await tui.press("enter");
    await tui.waitFor((text) => text.includes(`run ${runId}`) && text.includes("implement"));
  }, 120_000);

  it("quitting with a run going asks 'A run is going. Cancel it and quit?'; n stays, y cancels the run first and only then quits", async () => {
    const { tui, runner, runId } = await startedRun();
    await tui.press("escape");
    await tui.waitFor("enter opens it");

    await tui.press("ctrl+c");
    await tui.waitFor("A run is going. Cancel it and quit? y/n");
    await tui.type("n");
    await tui.waitFor("enter opens it");
    expect(tui.exited()).toBe(false);
    expect(runner.going()).toBe(true);

    await tui.type("/quit");
    await tui.press("enter");
    await tui.waitFor("A run is going. Cancel it and quit? y/n");
    await tui.type("y");
    await runner.settled();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tui.exited()).toBe(true);
    const [listed] = await listRuns({ repo });
    expect(listed?.runId).toBe(runId);
    expect(listed?.state?.state).toBe("cancelled");
  }, 120_000);

  it("quits at once when no run is going", async () => {
    const { tui } = await app(MOCK_ONLY);
    await tui.press("ctrl+c");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(tui.exited()).toBe(true);
  });
});

describe("`ahp \"<task>\"` on a terminal", () => {
  it("opens on that task's summary", async () => {
    const env = await toolsEnv(MOCK_ONLY);
    const { tui } = openApp({ repo, env, startTask: TASK });

    const frame = await tui.waitFor("m try it on the mock");

    expect(frame).toContain(TASK);
    expect(frame).not.toContain("No runs here yet.");
  });

  it("waits in the prompt while the first-open screens come first", async () => {
    forgetSettings();
    const env = await toolsEnv(MOCK_ONLY);
    const { tui } = openApp({ repo, env, startTask: TASK });

    await tui.waitFor("Tools on this machine");
  });
});
