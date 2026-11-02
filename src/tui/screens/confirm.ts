// A question that needs y or n (spec "Cancel"): "Cancel the run? y/n", and "A run is going. Cancel it and quit? y/n". It takes
// the whole screen while it is asked, so no other key can be mistaken for the answer; the screens underneath stay as they were.

import { Box, Text, useInput } from "ink";
import { Frame } from "../components/frame.ts";
import { Spinner } from "../components/spinner.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import { useTheme } from "../theme.ts";

export const CANCEL_QUESTION = "Cancel the run? y/n";
export const QUIT_QUESTION = "A run is going. Cancel it and quit? y/n";
export const QUITTING = "Cancelling the run: waiting for the agent to stop, then ahp quits.";

export interface ConfirmProps {
  layout: Layout;
  title: string;
  question: string;
  /** True once yes was answered and the app is waiting for what it started (the run's cancel) to finish. */
  waiting?: boolean;
  active: boolean;
  yes: () => void;
  no: () => void;
}

export function Confirm({ layout, title, question, waiting = false, active, yes, no }: ConfirmProps) {
  const theme = useTheme();
  const keys: KeyBinding[] = waiting
    ? []
    : [
        { keys: "y", label: "yes", match: is.char("y"), run: yes },
        { keys: "n", label: "no", match: is.char("n"), run: no },
        { keys: "esc", label: "no", footer: false, match: is.escape, run: no },
      ];
  useInput((input, key) => void dispatch(keys, input, key), { isActive: active });
  return h(Frame, { layout, title, keys }, h(Box, { flexDirection: "column", marginTop: 1, marginLeft: 1 }, waiting ? h(Spinner, { label: QUITTING }) : h(Text, { color: theme.color("warn"), bold: theme.bold }, question)));
}
