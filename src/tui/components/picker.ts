// A list to choose from: ↑↓ move, Enter chooses, typing narrows the list, Esc cancels. Its keys come from `pickerKeys`,
// which the screen holding a picker also puts in its footer.

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { filterByName } from "../commands.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import { SYMBOLS, useTheme } from "../theme.ts";
import { windowStart } from "./command-menu.ts";

export interface PickerItem<T> {
  label: string;
  /** Shown after the label, muted: where a default came from, a version. */
  hint?: string;
  value: T;
}

export interface PickerState {
  query: string;
  selected: number;
}

export interface PickerProps<T> {
  items: readonly PickerItem<T>[];
  onSelect: (item: PickerItem<T>) => void;
  onCancel: () => void;
  isActive?: boolean;
  height?: number;
}

export const pickerItems = <T>(items: readonly PickerItem<T>[], query: string): PickerItem<T>[] => filterByName(items, (item) => item.label, query);

/** The picker's keys over its state; `set` replaces the state, `select` and `cancel` end it. */
export function pickerKeys<T>(items: readonly PickerItem<T>[], state: PickerState, set: (state: PickerState) => void, select: (item: PickerItem<T>) => void, cancel: () => void): KeyBinding[] {
  const shown = pickerItems(items, state.query);
  const move = (by: number) => set({ ...state, selected: Math.max(0, Math.min(shown.length - 1, state.selected + by)) });
  return [
    { keys: "↑↓", label: "pick", match: is.upOrDown, run: (_, key) => move(key.upArrow ? -1 : 1) },
    { keys: "enter", label: "choose", when: shown.length > 0, match: is.enter, run: () => select(shown[Math.min(state.selected, shown.length - 1)]!) },
    { keys: "esc", label: "cancel", match: is.escape, run: cancel },
    { keys: "backspace", label: "erase a filter letter", footer: false, when: state.query !== "", match: (_, key) => key.backspace || key.delete, run: () => set({ query: state.query.slice(0, -1), selected: 0 }) },
  ];
}

export function Picker<T>({ items, onSelect, onCancel, isActive = true, height = 8 }: PickerProps<T>) {
  const theme = useTheme();
  const [state, setState] = useState<PickerState>({ query: "", selected: 0 });
  const keys = pickerKeys(items, state, setState, onSelect, onCancel);
  useInput(
    (input, key) => {
      if (dispatch(keys, input, key)) return;
      if (!key.ctrl && !key.meta && input.length > 0 && !/[\u0000-\u001f]/.test(input)) setState({ query: state.query + input, selected: 0 });
    },
    { isActive },
  );
  const shown = pickerItems(items, state.query);
  const first = windowStart(shown.length, state.selected, height);
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: theme.color("muted") }, state.query ? `filter: ${state.query}` : "type to filter"),
    shown.length === 0 ? h(Text, { color: theme.color("muted") }, "nothing matches") : null,
    ...shown.slice(first, first + height).map((item, offset) => {
      const on = first + offset === state.selected;
      return h(
        Box,
        { key: `${item.label}-${first + offset}`, backgroundColor: on ? theme.color("surface") : undefined },
        h(Text, { color: theme.color("accent") }, on ? `${SYMBOLS.caret} ` : "  "),
        h(Text, { color: theme.color(on ? "accent" : "text"), wrap: "truncate-end" }, item.label),
        item.hint ? h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, `  ${item.hint}`) : null,
      );
    }),
  );
}
