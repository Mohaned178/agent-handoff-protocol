// One table of keys per screen. The screen's input handler dispatches through the table and the footer prints the same
// table, so the footer can never list a key that does nothing, nor leave out one that works.

import type { Key } from "ink";

export interface KeyBinding {
  /** How the key is written in the footer and the help, e.g. "enter", "ctrl+c", "↑↓". */
  keys: string;
  /** What it does, in a word or two. */
  label: string;
  /** Whether a key press is this binding. */
  match: (input: string, key: Key) => boolean;
  run: (input: string, key: Key) => void;
  /** False while the binding does not apply (it then neither matches nor shows); default true. */
  when?: boolean;
  /** False to keep a working binding out of the footer (the help still lists it); default true. */
  footer?: boolean;
}

/** The bindings that apply now. */
export const activeKeys = (bindings: readonly KeyBinding[]): KeyBinding[] => bindings.filter((binding) => binding.when !== false);

/** The bindings the footer shows now. */
export const footerKeys = (bindings: readonly KeyBinding[]): KeyBinding[] => activeKeys(bindings).filter((binding) => binding.footer !== false);

/** Runs the first binding that applies and matches the key; false when none did. */
export function dispatch(bindings: readonly KeyBinding[], input: string, key: Key): boolean {
  const binding = activeKeys(bindings).find((candidate) => candidate.match(input, key));
  if (!binding) return false;
  binding.run(input, key);
  return true;
}

/** Matchers for the keys the screens use. */
export const is = {
  enter: (_: string, key: Key) => key.return,
  escape: (_: string, key: Key) => key.escape,
  tab: (_: string, key: Key) => key.tab && !key.shift,
  up: (_: string, key: Key) => key.upArrow,
  down: (_: string, key: Key) => key.downArrow,
  upOrDown: (_: string, key: Key) => key.upArrow || key.downArrow,
  ctrl: (letter: string) => (input: string, key: Key) => key.ctrl && input === letter,
  char: (char: string) => (input: string, key: Key) => !key.ctrl && !key.meta && input === char,
};
