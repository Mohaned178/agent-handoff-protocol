// How a screen moves the app: open another screen, go back, or quit. And the keys every screen has, so each screen's
// table (and so its footer) holds them the same way.

import { is, type KeyBinding } from "./keys.ts";
import type { Screen } from "./router.ts";

export interface Nav {
  open: (screen: Screen) => void;
  /** Opens the run screen on a run. */
  openRun: (runId: string) => void;
  back: () => void;
  quit: () => void;
}

/** `esc` back, `?` help (except on the help screen), `ctrl+c` quit: the keys of a screen with nothing typed in it. */
export function commonKeys(nav: Nav, options: { help?: boolean } = {}): KeyBinding[] {
  return [
    { keys: "esc", label: "back", match: is.escape, run: nav.back },
    { keys: "?", label: "help", when: options.help !== false, match: is.char("?"), run: () => nav.open("help") },
    { keys: "ctrl+c", label: "quit", match: is.ctrl("c"), run: nav.quit },
  ];
}
