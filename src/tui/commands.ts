// The slash commands (spec "Home: the prompt"). A menu opens on `/` and narrows as you type. A command whose screen is
// not built yet says which ticket builds it rather than pretend to work.

export interface SlashCommand {
  name: string;
  about: string;
  /** The ticket of `.scratch/new-terminal-ui/` that makes it work, while it does not yet. */
  comesIn?: string;
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: "model", about: "a step's tool and model", comesIn: "05" },
  { name: "effort", about: "a step's effort", comesIn: "05" },
  { name: "plan", about: "the plan step, on or off", comesIn: "05" },
  { name: "check", about: "the command that checks the work", comesIn: "05" },
  { name: "push", about: "where the result goes", comesIn: "05" },
  { name: "runs", about: "every run of this repository", comesIn: "07" },
  { name: "tools", about: "the coding tools on this machine", comesIn: "07" },
  { name: "settings", about: "your defaults for each step", comesIn: "07" },
  { name: "clean", about: "remove the worktrees of ended runs", comesIn: "07" },
  { name: "help", about: "keys and commands" },
  { name: "quit", about: "leave ahp" },
];

/** The items whose name holds `query`, case-insensitively: those starting with it first, each group in table order. */
export function filterByName<T>(items: readonly T[], nameOf: (item: T) => string, query: string): T[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return [...items];
  const starts = items.filter((item) => nameOf(item).toLowerCase().startsWith(wanted));
  const contains = items.filter((item) => !starts.includes(item) && nameOf(item).toLowerCase().includes(wanted));
  return [...starts, ...contains];
}

/** The text after `/` while the prompt holds a command being typed (one word, one line), or null when it does not. */
export function commandQuery(value: string): string | null {
  return /^\/[^\s]*$/.test(value) ? value.slice(1) : null;
}
