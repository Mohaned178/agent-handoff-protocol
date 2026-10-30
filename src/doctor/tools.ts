// The three coding-agent tools release 1 targets, and the only commands `ahp doctor` ever runs on them: a version
// command and, where the tool has one, its own login-status command. Never a prompt (it would spend the user's usage),
// and no credential or token file is opened, parsed or printed.

/** The tools doctor looks for; also the names of the adapters tickets 15, 16 and 18 register for them. A closed list. */
export const TOOL_IDS = ["claude-code", "codex", "opencode"] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/**
 * How a tool's login is read, and nothing more than the tool itself reveals.
 * - `none`: the tool has no status command that is safe to read, so the login is unknown.
 * - `json_logged_in`: the status command prints JSON with a boolean `loggedIn`; that boolean is read and the rest of the
 *   output, which can name an account, is discarded unread.
 * - `exit_code`: the status command exits 0 when logged in and `loggedOut` when not; any other exit says nothing.
 */
export type LoginProbe =
  | { kind: "none"; why: string }
  | { kind: "json_logged_in"; args: string[] }
  | { kind: "exit_code"; args: string[]; loggedOut: number };

export interface ToolDefinition {
  id: ToolId;
  name: string;
  /** The command looked up on PATH. */
  command: string;
  versionArgs: string[];
  login: LoginProbe;
  /** The name its adapter registers under in `adapters`; doctor reports capabilities only for a tool whose adapter does. */
  adapter: string;
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    versionArgs: ["--version"],
    login: { kind: "json_logged_in", args: ["auth", "status", "--json"] },
    adapter: "claude-code",
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "codex",
    versionArgs: ["--version"],
    login: { kind: "exit_code", args: ["login", "status"], loggedOut: 1 },
    adapter: "codex",
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    versionArgs: ["--version"],
    // `opencode auth list` prints the stored providers and credentials as free text; AHP reads none of it.
    login: { kind: "none", why: "its only status command, `auth list`, prints stored credentials as free text, which AHP does not read" },
    adapter: "opencode",
  },
];
