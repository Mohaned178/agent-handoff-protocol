// The slash commands (spec "Home: the prompt"). A menu opens on `/` and narrows as you type. The commands that change the
// next run take their arguments typed after the name; a command whose screen is not built yet says which ticket builds it
// rather than pretend to work.

export interface SlashCommand {
  name: string;
  about: string;
  /** The ticket of `.scratch/new-terminal-ui/` that makes it work, while it does not yet. */
  comesIn?: string;
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: "model", about: "a step's tool and model: /model implement codex gpt-5.6" },
  { name: "effort", about: "a step's effort: /effort review high" },
  { name: "plan", about: "the plan step, on or off: /plan on" },
  { name: "check", about: "the command that checks the work: /check npm test" },
  { name: "push", about: "where the result goes: /push origin" },
  { name: "runs", about: "every run of this repository", comesIn: "07" },
  { name: "tools", about: "the coding tools on this machine", comesIn: "07" },
  { name: "settings", about: "your defaults for each step", comesIn: "07" },
  { name: "clean", about: "remove the worktrees of ended runs", comesIn: "07" },
  { name: "help", about: "keys and commands" },
  { name: "quit", about: "leave ahp" },
];

/** The commands that change the next run, with their arguments typed after the name (they run from the prompt, not from the menu alone). */
export const RUN_COMMANDS = ["model", "effort", "plan", "check", "push"] as const;

/** The command and its argument in a prompt line that starts with `/`, or null when it does not. */
export function parseSlash(line: string): { name: string; argument: string } | null {
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(line.trim());
  return match ? { name: match[1]!.toLowerCase(), argument: match[2]!.trim() } : null;
}

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
