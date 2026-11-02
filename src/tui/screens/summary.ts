// The summary (spec "Summary: one look, one key"): what a task will do, every answer with where it came from. Enter runs it;
// Tab picks a step and Enter then changes its tool, model and effort; `p` adds or removes the plan step. A project with no
// check asks for one here. Before the run starts, the check runs once on the last commit (a check that already fails is said,
// and the person decides); the run itself is started by the app, and this screen hands over to its run screen once the run
// has an ID. Nothing runs without Enter, and a late answer from a precheck the person has left is dropped.

import { useEffect, useRef, useState } from "react";
import { Box, Text, usePaste, useInput } from "ink";
import { draftTask, CHANGED_HERE, type TaskDraft, type TaskSession } from "../../commands/task.ts";
import type { Role } from "../../doctor/init.ts";
import { TOOLS } from "../../doctor/tools.ts";
import { YOUR_DEFAULT } from "../../setup/infer.ts";
import type { OpenCodeAccess } from "../../setup/models.ts";
import { CHECK_TYPED, type TaskRun } from "../../setup/task.ts";
import { Frame } from "../components/frame.ts";
import { Prompt } from "../components/prompt.ts";
import { Spinner } from "../components/spinner.ts";
import { useStepChoice } from "../components/step-choice.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import type { Nav } from "../nav.ts";
import { editPrompt, emptyPrompt, promptActionOf, type PromptState } from "../prompt-model.ts";
import type { TaskContext, TaskSources } from "../sources.ts";
import { defaultOf } from "../step-choice-model.ts";
import { MOCK_NOTICE, REAL_AGENTS_NOTICE, summaryRows } from "../summary-model.ts";
import type { TaskRunner } from "../task-runner.ts";
import { SYMBOLS, useTheme } from "../theme.ts";
import { useRunner } from "../use-runner.ts";

export interface SummaryProps {
  layout: Layout;
  sources: TaskSources;
  runner: TaskRunner;
  nav: Nav;
  active: boolean;
  task: string;
  session: TaskSession;
  setSession: (change: (session: TaskSession) => TaskSession) => void;
  access: readonly OpenCodeAccess[] | null;
  setAccess: (access: readonly OpenCodeAccess[]) => void;
  /** Starts the run (the app builds the workflow, resets what the session changed, and notes the real-agents notice). */
  onStart: (run: TaskRun, context: TaskContext, mock: boolean) => void;
  /** Esc with nothing picked: back to the prompt with the task in it. */
  onEdit: () => void;
}

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; context: TaskContext };
type Phase = "idle" | "checking" | "failing" | "starting";

const LABEL_WIDTH = 11;
const VALUE_WIDTH = 40;

export function Summary({ layout, sources, runner, nav, active, task, session, setSession, access, setAccess, onStart, onEdit }: SummaryProps) {
  const theme = useTheme();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [selected, setSelected] = useState<Role | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [failing, setFailing] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [typing, setTyping] = useState<PromptState | null>(null);
  // "Save as workflow": the file's name being typed, and the path once it is written.
  const [naming, setNaming] = useState<PromptState | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const attempt = useRef(0);
  const going = useRunner(runner);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void sources.context(session.remote).then(
      (context) => live && setLoaded({ state: "ready", context }),
      (error: unknown) => live && setLoaded({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [active, sources, session.remote]);

  const context = loaded.state === "ready" ? loaded.context : null;
  const draft: TaskDraft | null = context ? draftTask({ task, found: context.found, base: context.base, session, branches: context.branches }) : null;
  const roles = draft ? draft.run.assignments.map((assignment) => assignment.role) : [];

  const choosing = useStepChoice({
    report: context?.report ?? null,
    models: sources.models,
    access,
    setAccess,
    askKeep: true,
    reason: CHANGED_HERE,
    isActive: active && phase === "idle",
    onDone: (assignment, keep) => {
      const step = keep ? { ...assignment, reason: YOUR_DEFAULT } : assignment;
      setSession((current) => ({ ...current, steps: { ...current.steps, [step.role]: step } }));
      const chosen = defaultOf(step);
      if (keep && chosen) void sources.saveDefault(step.role, chosen).catch((error: unknown) => setProblem(`your default could not be saved: ${error instanceof Error ? error.message : String(error)}`));
    },
  });

  // The run is started by the app; this screen waits for its ID, then the run screen takes over.
  useEffect(() => {
    if (phase !== "starting" || going === null) return;
    if (going.runId !== null) nav.openRun(going.runId);
    else if (going.phase === "ended") {
      setProblem(going.error ?? "the run ended before it recorded anything");
      setPhase("idle");
    }
  }, [phase, going, nav]);

  const begin = (run: TaskRun) => {
    if (!context) return;
    setPhase("starting");
    try {
      onStart(run, context, session.mock);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setPhase("idle");
    }
  };
  const run = (skipCheck: boolean) => {
    if (!draft || !context) return;
    const id = ++attempt.current;
    setProblem(null);
    const { check, install } = draft.run;
    if (check === null || skipCheck) return begin(draft.run);
    setPhase("checking");
    sources.precheck(context.repo, check.command, install?.command ?? null).then(
      (result) => {
        if (attempt.current !== id) return;
        if (result.passed) begin(draft.run);
        else {
          setFailing(result.line);
          setPhase("failing");
        }
      },
      (error: unknown) => {
        if (attempt.current !== id) return;
        setProblem(`the check could not be tried on your last commit: ${error instanceof Error ? error.message : String(error)}`);
        setPhase("idle");
      },
    );
  };
  const leaveCheck = () => {
    attempt.current++;
    setPhase("idle");
  };
  const nextStep = () => setSelected((current) => (roles.length === 0 ? null : current === null ? roles[0]! : (roles[roles.indexOf(current) + 1] ?? null)));
  const typeCheck = (action: Parameters<typeof editPrompt>[1]) => setTyping((current) => (current ? editPrompt(current, action).state : current));
  const typeName = (action: Parameters<typeof editPrompt>[1]) => setNaming((current) => (current ? editPrompt(current, action).state : current));
  const saveWorkflow = () => {
    if (!draft || naming === null) return;
    setProblem(null);
    sources.saveWorkflow(naming.value, draft.run).then(
      (path) => (setSavedTo(path), setNaming(null)),
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    );
  };

  const ready = draft !== null && !draft.needsCheck && !draft.noTool;
  let keys: KeyBinding[];
  if (choosing.active) keys = choosing.keys;
  else if (phase === "checking") keys = [{ keys: "esc", label: "stop checking", match: is.escape, run: leaveCheck }];
  else if (phase === "failing") {
    keys = [
      { keys: "enter", label: "run anyway", match: is.enter, run: () => (setPhase("idle"), run(true)) },
      { keys: "esc", label: "back", match: is.escape, run: leaveCheck },
    ];
  } else if (phase === "starting") keys = [];
  else if (naming !== null) {
    keys = [
      { keys: "enter", label: "save", when: naming.value.trim() !== "", match: is.enter, run: saveWorkflow },
      { keys: "esc", label: "cancel", match: is.escape, run: () => (setProblem(null), setNaming(null)) },
    ];
  } else if (typing !== null) {
    keys = [
      { keys: "enter", label: "use this check", when: typing.value.trim() !== "", match: is.enter, run: () => (setSession((current) => ({ ...current, check: { command: typing.value.trim(), source: CHECK_TYPED } })), setTyping(null)) },
      { keys: "esc", label: "cancel", match: is.escape, run: () => setTyping(null) },
    ];
  } else {
    keys = [
      { keys: "enter", label: "run", when: ready && selected === null, match: is.enter, run: () => run(false) },
      { keys: "enter", label: `change ${selected}`, when: selected !== null, match: is.enter, run: () => choosing.start(selected!) },
      { keys: "tab", label: selected === null ? "change a step" : "next step", when: roles.length > 0 && !draft?.noTool, match: is.tab, run: nextStep },
      { keys: "p", label: session.plan ? "remove the plan step" : "add a plan step", when: draft !== null && !draft.noTool, match: is.char("p"), run: () => (setSelected((current) => (current === "plan" ? null : current)), setSession((current) => ({ ...current, plan: !current.plan }))) },
      { keys: "t", label: "type a check", when: draft?.needsCheck === true, match: is.char("t"), run: () => setTyping(emptyPrompt()) },
      { keys: "n", label: "no check: review only", when: draft?.needsCheck === true, match: is.char("n"), run: () => setSession((current) => ({ ...current, check: "none" })) },
      { keys: "w", label: "save as workflow", when: ready, match: is.char("w"), run: () => (setSavedTo(null), setProblem(null), setNaming(emptyPrompt())) },
      { keys: "m", label: "try it on the mock", when: draft?.noTool === true, match: is.char("m"), run: () => setSession((current) => ({ ...current, mock: true })) },
      { keys: "esc", label: selected === null ? "edit" : "unpick", match: is.escape, run: () => (selected === null ? onEdit() : setSelected(null)) },
      { keys: "?", label: "help", footer: false, match: is.char("?"), run: () => nav.open("help") },
      { keys: "ctrl+c", label: "quit", match: is.ctrl("c"), run: nav.quit },
    ];
  }
  useInput(
    (input, key) => {
      if (dispatch(keys, input, key)) return;
      if (typing !== null) {
        const action = promptActionOf(input, key);
        if (action) typeCheck(action);
      } else if (naming !== null) {
        const action = promptActionOf(input, key);
        if (action) typeName(action);
      }
    },
    { isActive: active && !choosing.active },
  );
  usePaste((text) => (naming !== null ? typeName({ type: "insert", text }) : typeCheck({ type: "insert", text })), { isActive: active && (typing !== null || naming !== null) });

  const body: ReturnType<typeof h>[] = [];
  if (loaded.state === "loading") body.push(h(Spinner, { key: "loading", label: "reading the project" }));
  else if (loaded.state === "failed") body.push(h(Text, { key: "failed", color: theme.color("error"), wrap: "wrap" }, `The project could not be read: ${loaded.message}`));
  else if (choosing.active) body.push(h(Box, { key: "choice", flexDirection: "column" }, choosing.view));
  else if (draft && context) {
    body.push(h(Text, { key: "task", color: theme.color("text"), bold: theme.bold, wrap: "wrap" }, task));
    body.push(h(Text, { key: "gap" }, " "));
    for (const row of summaryRows({ run: draft.run, needsCheck: draft.needsCheck, uncommitted: context.uncommitted })) {
      const on = row.role !== undefined && row.role === selected;
      body.push(
        h(
          Box,
          { key: row.key, backgroundColor: on ? theme.color("surface") : undefined },
          h(Text, { color: theme.color("accent") }, on ? "❯ " : "  "),
          h(Box, { width: LABEL_WIDTH, flexShrink: 0 }, h(Text, { color: theme.color(on ? "accent" : "text") }, row.label)),
          h(Box, { width: row.source === "" ? undefined : VALUE_WIDTH, flexShrink: row.source === "" ? 1 : 0, marginRight: 1 }, h(Text, { color: theme.color(row.key === "note" ? "warn" : "text"), wrap: "truncate-end" }, row.value)),
          row.source === "" ? null : h(Text, { color: theme.color(row.sourceTone), wrap: "truncate-end" }, row.source),
        ),
      );
    }
    if (naming !== null) body.push(h(Box, { key: "naming", flexDirection: "column", marginTop: 1 }, h(Text, { color: theme.color("text") }, "Save this task's workflow as (in the repository, .mjs; an existing file is not replaced):"), h(Prompt, { state: naming, placeholder: "e.g. password-reset.mjs", focused: true })));
    else if (savedTo !== null) body.push(h(Text, { key: "saved", color: theme.color("accent"), wrap: "wrap" }, `${SYMBOLS.ok} saved ${savedTo}: ahp run ${savedTo} runs it again`));
    if (typing !== null) body.push(h(Box, { key: "typing", flexDirection: "column", marginTop: 1 }, h(Text, { color: theme.color("text") }, "The command that checks the work (exit code 0 means done):"), h(Prompt, { state: typing, placeholder: "e.g. npm test", focused: true })));
    else if (draft.needsCheck) body.push(h(Text, { key: "ask", color: theme.color("warn"), wrap: "wrap" }, "What checks this work? t type a command, n none (a reviewing agent reads it; it is labelled not verified)"));
    if (draft.noTool) {
      body.push(h(Text, { key: "gap2" }, " "));
      body.push(h(Text, { key: "notool", color: theme.color("warn"), wrap: "wrap" }, "No coding tool is usable here. Install one and log in with your own account:"));
      for (const tool of TOOLS) body.push(h(Text, { key: tool.id, color: theme.color("muted"), wrap: "truncate-end" }, `  ${tool.name.padEnd(12)} ${tool.install}, then ${tool.logIn}`));
      body.push(h(Text, { key: "mockhint", color: theme.color("muted") }, "Or try the flow on the scripted mock: m"));
    } else if (session.mock) body.push(h(Text, { key: "mock", color: theme.color("warn"), wrap: "wrap" }, `! ${MOCK_NOTICE}`));
    else if (context.settings.settings.realAgentsNoticed !== true) body.push(h(Text, { key: "real", color: theme.color("warn"), wrap: "wrap" }, `! ${REAL_AGENTS_NOTICE}`));
    if (phase === "checking") body.push(h(Spinner, { key: "checking", label: `checking \`${draft.run.check?.command}\` on your last commit` }));
    if (phase === "failing") body.push(h(Text, { key: "failing", color: theme.color("warn"), wrap: "wrap" }, `! \`${draft.run.check?.command}\` already fails on your last commit: ${failing}\n  The agents are asked to make it pass. enter runs it anyway, esc goes back.`));
    if (phase === "starting") body.push(h(Spinner, { key: "starting", label: "starting the run" }));
  }
  if (problem) body.push(h(Text, { key: "problem", color: theme.color("error"), wrap: "wrap" }, problem));

  return h(Frame, { layout, title: `summary${session.mock ? " · mock" : ""}`, keys }, h(Box, { flexDirection: "column", marginTop: 1 }, ...body));
}
