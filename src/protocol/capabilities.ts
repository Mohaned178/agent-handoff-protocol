// Capabilities, network stance and what an adapter declares about itself. Every list here is closed: a new value is a
// protocol change. A capability is something a step asks of the coding agent's tool use, and the level it is applied at
// says how much the tool upholds it. A worktree isolates files; none of this makes it a sandbox.

/**
 * How strongly an applied capability is upheld, from the strongest down. A closed list.
 * - `enforced_by_tool`: the coding agent's own tool blocks what the capability forbids (a permission rule or hook it
 *   applies itself), so the agent cannot do it however it is prompted.
 * - `cooperative`: the agent is asked not to (a prompt instruction, an ACP permission request it may answer or ignore),
 *   and nothing stops it. This is not enforcement.
 * - `none`: nothing is applied.
 */
export const ENFORCEMENT_LEVELS = ["enforced_by_tool", "cooperative", "none"] as const;
export type EnforcementLevel = (typeof ENFORCEMENT_LEVELS)[number];

const STRENGTH: Record<EnforcementLevel, number> = { none: 0, cooperative: 1, enforced_by_tool: 2 };

/** Whether `achieved` upholds a capability at least as strongly as `required` asks. */
export const meetsLevel = (achieved: EnforcementLevel, required: EnforcementLevel): boolean => STRENGTH[achieved] >= STRENGTH[required];

/**
 * What a step can ask of its coding agent's tool use. A closed list.
 * - `read_only`: change no file in the workspace.
 * - `write_scope`: change files only under the listed repository-relative paths.
 * - `no_external_actions`: push, open or merge nothing and change no shared ref (ADR 0003); only AHP does. Every agent
 *   step carries it, whether or not the workflow lists it.
 */
export const CAPABILITY_KINDS = ["read_only", "write_scope", "no_external_actions"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/**
 * The network access a step permits to the coding agent's own tool use (web fetch and search, shell network), never the
 * agent's connection to its model provider. A closed list.
 * - `deny`: none. The default.
 * - `package_registries`: package registries only, to install dependencies.
 */
export const NETWORK_STANCES = ["deny", "package_registries"] as const;
export type NetworkStance = (typeof NETWORK_STANCES)[number];

export const DEFAULT_NETWORK_STANCE: NetworkStance = "deny";

/**
 * The level a capability a workflow lists must be applied at, unless it says otherwise: asked of the agent at least.
 * A workflow that lists a capability wants it, so an adapter that cannot even ask is rejected, rather than the run
 * going on without it.
 */
export const DEFAULT_CAPABILITY_REQUIREMENT: EnforcementLevel = "cooperative";

/**
 * The level the network stance must be applied at, unless the workflow says otherwise: none, so it is applied as far as
 * the adapter can and reported, and never the reason a handoff is rejected. Every adapter would otherwise be rejected
 * by the default stance, since no tool can block the network use of every shell command.
 */
export const DEFAULT_NETWORK_REQUIREMENT: EnforcementLevel = "none";

/** What the baseline `no_external_actions` must be applied at: none, so it is applied as far as the adapter can and reported. */
export const BASELINE_REQUIREMENT: EnforcementLevel = "none";

/** The operating systems an adapter declares levels for: the values of Node's `process.platform` that AHP supports. */
export const OPERATING_SYSTEMS = ["win32", "darwin", "linux"] as const;
export type OperatingSystem = (typeof OPERATING_SYSTEMS)[number];

/** An adapter's level for one capability or stance on each operating system; spelled out for every one. */
export type LevelsByOs = Record<OperatingSystem, EnforcementLevel>;

/** The level on `platform` (a Node `process.platform` value); `none` on a system AHP does not support. */
export function levelOn(levels: LevelsByOs, platform: string): EnforcementLevel {
  return (OPERATING_SYSTEMS as readonly string[]).includes(platform) ? levels[platform as OperatingSystem] : "none";
}

/** The same level on every operating system. */
export const sameOnEveryOs = (level: EnforcementLevel): LevelsByOs => ({ win32: level, darwin: level, linux: level });

/**
 * How an adapter drives its coding agent (ADR 0001). A closed list.
 * - `acp`: the tool's native Agent Client Protocol interface.
 * - `sdk`: the vendor's SDK.
 * - `headless`: the tool's headless mode, one process per attempt.
 * - `mock`: the scripted mock adapter, which drives no real tool.
 */
export const TRANSPORT_KINDS = ["acp", "sdk", "headless", "mock"] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

/**
 * How much an adapter can say about the model its tool runs. AHP never claims to discover what a subscription entitles
 * the user to. A closed list.
 * - `enumerable`: the integration lists the models that can be selected.
 * - `pass_through`: the tool accepts a model name, which AHP passes on unvalidated.
 * - `not_exposed`: the tool offers no choice of model.
 */
export const MODEL_REPORTING_LEVELS = ["enumerable", "pass_through", "not_exposed"] as const;
export type ModelReportingLevel = (typeof MODEL_REPORTING_LEVELS)[number];

/**
 * The login an adapter's tool needs. AHP stores no credential: the tool keeps its own. A closed list.
 * - `none`: no login (the mock).
 * - `tool_login`: a login made in the tool itself, such as a subscription or an account.
 * - `api_key`: an API key configured through the tool's own settings or environment.
 */
export const LOGIN_KINDS = ["none", "tool_login", "api_key"] as const;
export type LoginKind = (typeof LOGIN_KINDS)[number];

/** What a model name is when the tool did not report one. */
export const UNKNOWN_MODEL = "unknown";

/**
 * What a coding agent's tool reported it used for an attempt, as the adapter normalizes it. A number the tool did not
 * report is null, never 0, and nothing here is ever estimated, derived from output length or summed across attempts.
 */
export interface UsageReport {
  /** Where the numbers came from, in the adapter's words (for example the stream event or report that carried them). Not empty. */
  source: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  /** The cost the tool reported, in the currency it reported; null when it reported none (a subscription has no cost). */
  cost: { amount: number; currency: string } | null;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Whether `usage` is something a tool could have reported: it names its source, every number is finite and not negative,
 * and it reports at least one number. Anything else is not recorded as usage.
 */
export function isUsageReport(usage: unknown): usage is UsageReport {
  if (typeof usage !== "object" || usage === null) return false;
  const { source, inputTokens, outputTokens, totalTokens, cachedInputTokens, cost } = usage as Record<string, unknown>;
  if (typeof source !== "string" || source.trim() === "") return false;
  const counts = [inputTokens, outputTokens, totalTokens, cachedInputTokens];
  if (!counts.every((count) => count === null || isCount(count))) return false;
  if (cost !== null) {
    if (typeof cost !== "object") return false;
    const { amount, currency } = cost as Record<string, unknown>;
    if (!isCount(amount) || typeof currency !== "string" || currency.trim() === "") return false;
  }
  return counts.some((count) => count !== null) || cost !== null;
}
