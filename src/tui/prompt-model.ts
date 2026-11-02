// The prompt's editing, as a pure function of its state: typing, deleting, moving the cursor, browsing earlier entries
// with ↑↓ while the prompt is empty (or still shows an entry recalled that way), pasting several lines, and Enter, which
// submits unless the character before the cursor is `\` (then it becomes a new line).

export interface PromptState {
  value: string;
  /** Index into `value`, 0 to `value.length`. */
  cursor: number;
  /** Entries submitted before, oldest first. */
  history: readonly string[];
  /** Which history entry is shown, or null when the person is writing their own. */
  recalled: number | null;
}

export type PromptAction =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "up" }
  | { type: "down" }
  | { type: "enter" }
  | { type: "clear" }
  | { type: "set"; value: string };

export interface PromptResult {
  state: PromptState;
  /** The text submitted by this action (Enter), or null. */
  submitted: string | null;
}

/** The editing action a key press makes in a text field (Enter, Esc and the history keys are the screen's), or null. */
export function promptActionOf(input: string, key: { backspace: boolean; delete: boolean; leftArrow: boolean; rightArrow: boolean; home?: boolean; end?: boolean; ctrl: boolean; meta: boolean; escape: boolean; tab: boolean; return: boolean; upArrow: boolean; downArrow: boolean; pageUp: boolean; pageDown: boolean }): PromptAction | null {
  if (key.backspace) return { type: "backspace" };
  if (key.delete) return { type: "delete" };
  if (key.leftArrow) return { type: "left" };
  if (key.rightArrow) return { type: "right" };
  if (key.home) return { type: "home" };
  if (key.end) return { type: "end" };
  if (key.ctrl || key.meta || key.escape || key.tab || key.return || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return null;
  return input !== "" ? { type: "insert", text: input } : null;
}

export const emptyPrompt = (history: readonly string[] = []): PromptState => ({ value: "", cursor: 0, history, recalled: null });

/** Whether ↑↓ browse the history now: the prompt is empty, or shows an entry recalled and not edited. */
export const browsingHistory = (state: PromptState): boolean =>
  state.history.length > 0 && (state.value === "" || (state.recalled !== null && state.history[state.recalled] === state.value));

const at = (state: PromptState, value: string, cursor: number): PromptState => ({ ...state, value, cursor, recalled: null });

/** Pasted or typed text with its line endings made `\n`, and no other control character. */
export const cleanText = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");

export function editPrompt(state: PromptState, action: PromptAction): PromptResult {
  const { value, cursor } = state;
  const next = (changed: PromptState): PromptResult => ({ state: changed, submitted: null });
  switch (action.type) {
    case "insert": {
      const text = cleanText(action.text);
      return next(at(state, value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length));
    }
    case "backspace":
      return cursor === 0 ? next(state) : next(at(state, value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1));
    case "delete":
      return cursor === value.length ? next(state) : next(at(state, value.slice(0, cursor) + value.slice(cursor + 1), cursor));
    case "left":
      return next({ ...state, cursor: Math.max(0, cursor - 1) });
    case "right":
      return next({ ...state, cursor: Math.min(value.length, cursor + 1) });
    case "home":
      return next({ ...state, cursor: value.lastIndexOf("\n", cursor - 1) + 1 });
    case "end": {
      const end = value.indexOf("\n", cursor);
      return next({ ...state, cursor: end === -1 ? value.length : end });
    }
    case "up": {
      if (!browsingHistory(state)) return next(state);
      const index = state.recalled === null ? state.history.length - 1 : Math.max(0, state.recalled - 1);
      const entry = state.history[index]!;
      return next({ ...state, value: entry, cursor: entry.length, recalled: index });
    }
    case "down": {
      if (!browsingHistory(state) || state.recalled === null) return next(state);
      if (state.recalled === state.history.length - 1) return next({ ...state, value: "", cursor: 0, recalled: null });
      const entry = state.history[state.recalled + 1]!;
      return next({ ...state, value: entry, cursor: entry.length, recalled: state.recalled + 1 });
    }
    case "enter": {
      if (cursor > 0 && value[cursor - 1] === "\\") return next(at(state, `${value.slice(0, cursor - 1)}\n${value.slice(cursor)}`, cursor));
      const submitted = value.trim();
      if (submitted === "") return next(state);
      const history = state.history.at(-1) === submitted ? state.history : [...state.history, submitted];
      return { state: emptyPrompt(history), submitted };
    }
    case "clear":
      return next(emptyPrompt(state.history));
    case "set":
      return next(at(state, action.value, action.value.length));
  }
}
