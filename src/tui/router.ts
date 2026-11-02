// The screens and how one gets from one to another: a stack, so `esc` goes back where you came from. Home is the bottom
// of the stack and nothing goes back past it.

export const SCREENS = ["welcome", "roles", "ready", "home", "summary", "run", "runs", "tools", "settings", "help"] as const;
export type Screen = (typeof SCREENS)[number];

export interface RouterState {
  /** The screens opened, oldest first; the last is on screen. Never empty. */
  stack: readonly Screen[];
}

export type RouterAction = { type: "open"; screen: Screen; /** Takes the place of the screen on top rather than stacking on it: the summary, once its run has started. */ replace?: boolean } | { type: "back" } | { type: "home" };

export const startAt = (screen: Screen = "home"): RouterState => ({ stack: screen === "home" ? ["home"] : ["home", screen] });

export const currentScreen = (state: RouterState): Screen => state.stack.at(-1)!;

export function route(state: RouterState, action: RouterAction): RouterState {
  switch (action.type) {
    case "open": {
      if (action.screen === "home") return startAt();
      if (currentScreen(state) === action.screen) return state;
      // A screen opened again comes forward rather than stacking a second copy.
      const kept = action.replace ? state.stack.slice(0, -1) : state.stack;
      return { stack: [...kept.filter((screen) => screen !== action.screen), action.screen] };
    }
    case "back":
      return state.stack.length > 1 ? { stack: state.stack.slice(0, -1) } : state;
    case "home":
      return startAt();
  }
}
