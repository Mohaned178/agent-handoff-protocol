// The tool, model and effort of one step, chosen in place (spec D6). `useStepChoice` holds the whole flow: the screen that
// uses it puts `keys` in its footer, `view` in its body, and turns its own input off while `active`. The phases and what
// each answer does are `step-choice-model.ts`'s; this only shows them and feeds the answers in.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, usePaste, useInput } from "ink";
import type { DoctorReport } from "../../doctor/doctor.ts";
import type { Role, RoleAssignment } from "../../doctor/init.ts";
import { OPENCODE_ACCESS, OPENCODE_ACCESS_NAMES, type ModelList, type OpenCodeAccess } from "../../setup/models.ts";
import type { ToolId } from "../../doctor/tools.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import { editPrompt, emptyPrompt, promptActionOf, type PromptState } from "../prompt-model.ts";
import { advance, assignmentOf, effortChoices, KEEP_CHOICES, modelChoices, questionOf, startChoice, toolChoices, type Answer, type StepChoice } from "../step-choice-model.ts";
import { useTheme } from "../theme.ts";
import { filterText, PickerView, pickerKeys, type PickerItem, type PickerState } from "./picker.ts";
import { Prompt } from "./prompt.ts";
import { Spinner } from "./spinner.ts";

export interface StepChoiceOptions {
  report: DoctorReport | null;
  /** The models to offer for a tool (the tool's list, or the names AHP knows). */
  models: (tool: ToolId) => Promise<ModelList>;
  /** OpenCode's access as the person said it, or null while not asked: asked once, kept by the caller. */
  access: readonly OpenCodeAccess[] | null;
  setAccess: (access: readonly OpenCodeAccess[]) => void;
  /** Whether "use this next time?" is asked at the end. */
  askKeep: boolean;
  /** The assignment's `reason`: where the step's answer came from, in the summary's words. */
  reason: string;
  /** The step chosen, and whether to keep it as the person's default. */
  onDone: (assignment: RoleAssignment, keep: boolean) => void;
  /** False while another layer holds the keyboard. */
  isActive: boolean;
}

export interface StepChoiceApi {
  /** Whether a choice is open: the screen's own keys are off then. */
  active: boolean;
  start: (role: Role) => void;
  /** The keys of the phase now, for the footer. */
  keys: KeyBinding[];
  view: ReactNode;
}

type Loaded = { state: "loading" } | { state: "ready"; list: ModelList };
const FIRST: PickerState = { query: "", selected: 0 };

export function useStepChoice(options: StepChoiceOptions): StepChoiceApi {
  const theme = useTheme();
  const { report, access } = options;
  const [choice, setChoice] = useState<StepChoice | null>(null);
  const [picker, setPicker] = useState<PickerState>(FIRST);
  const [cursor, setCursor] = useState(0);
  const [ticked, setTicked] = useState<ReadonlySet<OpenCodeAccess>>(new Set());
  const [typed, setTyped] = useState<PromptState>(emptyPrompt());
  const [notice, setNotice] = useState<string | null>(null);
  const [listed, setListed] = useState<Loaded>({ state: "loading" });
  const lists = useRef(new Map<ToolId, ModelList>());
  const modelsOf = useRef(options.models);
  modelsOf.current = options.models;

  const phase = choice?.phase ?? null;
  const tool = choice?.tool ?? null;
  useEffect(() => {
    if (phase !== "model" || tool === null) return;
    const known = lists.current.get(tool);
    if (known) return setListed({ state: "ready", list: known });
    let live = true;
    setListed({ state: "loading" });
    void modelsOf.current(tool).then(
      (list) => {
        lists.current.set(tool, list);
        if (live) setListed({ state: "ready", list });
      },
      (error: unknown) => {
        // A tool that cannot list its models still has its default and a typed name.
        if (live) setListed({ state: "ready", list: { choices: [{ value: null, label: "the tool's own default (no model requested)" }], source: `the models could not be listed: ${error instanceof Error ? error.message : String(error)}` } });
      },
    );
    return () => {
      live = false;
    };
  }, [phase, tool]);

  const close = () => {
    setChoice(null);
    setNotice(null);
  };
  const go = (next: StepChoice) => {
    setPicker(FIRST);
    setNotice(null);
    setTyped(emptyPrompt());
    if (next.phase === "done") {
      close();
      options.onDone(assignmentOf(next, options.reason), next.keep);
    } else setChoice(next);
  };
  const give = (answer: Answer) => {
    if (choice) go(advance(choice, answer, { askKeep: options.askKeep, accessKnown: access !== null }));
  };

  const accessNow = access ?? [...ticked];
  const items: PickerItem<unknown>[] =
    choice === null || report === null
      ? []
      : phase === "tool"
        ? toolChoices(report)
        : phase === "model" && listed.state === "ready" && tool !== null
          ? modelChoices(listed.list, tool, accessNow)
          : phase === "effort" && tool !== null
            ? effortChoices(tool)
            : phase === "keep"
              ? KEEP_CHOICES
              : [];

  const select = (item: PickerItem<unknown>) => {
    if (!choice) return;
    switch (choice.phase) {
      case "tool": {
        const row = toolChoices(report!).find((candidate) => candidate.value === item.value)!;
        if (!row.row.usable) return setNotice(`${row.label} is not usable here: ${row.hint}`);
        return give({ tool: item.value as ToolId });
      }
      case "model":
        return give({ model: item.value as string | null });
      case "effort":
        return give({ effort: item.value as string | null });
      case "keep":
        return give({ keep: item.value as boolean });
    }
  };
  const cancel = () => {
    close();
    setPicker(FIRST);
  };

  let keys: KeyBinding[] = [];
  if (choice !== null) {
    if (phase === "access") {
      const names = OPENCODE_ACCESS.map((id) => id);
      keys = [
        { keys: "↑↓", label: "move", match: is.upOrDown, run: (_, key) => setCursor(Math.max(0, Math.min(names.length - 1, cursor + (key.upArrow ? -1 : 1)))) },
        {
          keys: "space",
          label: "tick",
          match: is.char(" "),
          run: () =>
            setTicked((current) => {
              const next = new Set(current);
              const id = names[cursor]!;
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            }),
        },
        {
          keys: "enter",
          label: "continue",
          match: is.enter,
          run: () => {
            options.setAccess([...ticked]);
            give({ access: [...ticked] });
          },
        },
        { keys: "esc", label: "cancel", match: is.escape, run: cancel },
      ];
    } else if (phase === "typed") {
      keys = [
        { keys: "enter", label: "use this name", when: typed.value.trim() !== "", match: is.enter, run: () => give({ typed: typed.value }) },
        { keys: "esc", label: "cancel", match: is.escape, run: cancel },
      ];
    } else {
      keys = pickerKeys(items, picker, setPicker, select, cancel);
    }
  }

  useInput(
    (input, key) => {
      if (dispatch(keys, input, key)) return;
      if (phase === "typed") {
        const action = promptActionOf(input, key);
        if (action) setTyped(editPrompt(typed, action).state);
        return;
      }
      const letter = filterText(input, key);
      if (letter !== null && (phase === "tool" || phase === "model" || phase === "effort")) setPicker({ query: picker.query + letter, selected: 0 });
    },
    { isActive: options.isActive && choice !== null },
  );
  usePaste((text) => setTyped(editPrompt(typed, { type: "insert", text }).state), { isActive: options.isActive && phase === "typed" });

  let body: ReactNode = null;
  if (choice !== null) {
    if (report === null) body = h(Spinner, { label: "looking at the tools on this machine" });
    else if (phase === "access") {
      body = h(
        Box,
        { flexDirection: "column" },
        ...OPENCODE_ACCESS.map((id, index) =>
          h(
            Box,
            { key: id, backgroundColor: index === cursor ? theme.color("surface") : undefined },
            h(Text, { color: theme.color("accent") }, index === cursor ? "❯ " : "  "),
            h(Text, { color: theme.color(ticked.has(id) ? "accent" : "text") }, `${ticked.has(id) ? "[x]" : "[ ]"} ${OPENCODE_ACCESS_NAMES[id].name}`),
            h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, `  ${OPENCODE_ACCESS_NAMES[id].description}`),
          ),
        ),
      );
    } else if (phase === "typed") body = h(Prompt, { state: typed, placeholder: "model name", focused: true });
    else if (phase === "model" && listed.state === "loading") body = h(Spinner, { label: `listing ${tool}'s models` });
    else
      body = h(
        Box,
        { flexDirection: "column" },
        phase === "model" && listed.state === "ready" ? h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, `from ${listed.list.source}`) : null,
        h(PickerView<unknown>, { items, state: picker, height: 8 }),
      );
  }
  const view: ReactNode =
    choice === null
      ? null
      : h(Box, { flexDirection: "column" }, h(Text, { color: theme.color("text"), bold: theme.bold, wrap: "truncate-end" }, questionOf(choice)), notice ? h(Text, { color: theme.color("error"), wrap: "truncate-end" }, notice) : null, body);

  const start = (role: Role) => {
    setPicker(FIRST);
    setNotice(null);
    setCursor(0);
    setTicked(new Set());
    setChoice(startChoice(role));
  };
  return { active: choice !== null, start, keys, view };
}

