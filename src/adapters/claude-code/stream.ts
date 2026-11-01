// Reads the stream `claude -p --output-format stream-json --verbose` prints: one JSON object per line. Claude Code adds
// event types between versions, so only what the adapter needs is looked at and every other line is ignored; a line that
// is not JSON (the torn last line of a killed process) is ignored too. Nothing here is derived from output length or time:
// a number or a model the tool did not state is absent.

import type { AdapterErrorKind, AttemptError, OutputFieldValue, StopReason, UsageReport } from "../../protocol/index.ts";
import type { ActivityItem } from "../activity.ts";

/** The error codes Claude Code puts on an assistant message that is an API error: the list is its own schema's (read from the installed 2.1.311). */
const ERROR_KIND: Record<string, AdapterErrorKind> = {
  authentication_failed: "config_auth",
  oauth_org_not_allowed: "config_auth",
  account_on_hold: "config_auth",
  verification_required: "config_auth",
  billing_error: "config_auth",
  cloud_credential_error: "config_auth",
  model_not_found: "config_auth",
  rate_limit: "transient",
  overloaded: "transient",
  server_error: "transient",
};

/** The `result` event's HTTP status, when it carries one. */
function kindOfStatus(status: unknown): AdapterErrorKind | null {
  if (typeof status !== "number") return null;
  if (status === 401) return "config_auth";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export interface ParsedExit {
  reportedOutput: Record<string, OutputFieldValue>;
  stopReason: StopReason | null;
  error: AttemptError | null;
  reportedModel: string | null;
  usage: UsageReport | null;
}

/** The input fields that name a file or directory, in Claude Code's own tools (`Read`, `Write`, `Edit`, `NotebookEdit`, `Grep`, `Glob`). */
const PATH_FIELDS = ["file_path", "notebook_path", "path"];
/** The input field that best says what a call does, when it is not a file: a shell command, a search pattern, a URL. */
const TITLE_FIELDS = ["command", "pattern", "url", "query"];

export class ClaudeStream {
  private apiKeySource: string | null = null;
  private readonly models: string[] = [];
  private assistantError: string | null = null;
  private result: Json | null = null;
  private pending = "";
  /** The tool calls seen so far, by the `tool_use` id, so their `tool_result` can be logged with what they were. */
  private readonly calls = new Map<string, { kind: string | null; title: string | null; paths: string[] }>();
  /** The messages whose usage has been passed on: Claude Code repeats a message's usage on each of its content blocks. */
  private readonly usageSeen = new Set<string>();

  /**
   * Called with each thing the stream reports while the agent works, for the activity log: tool calls from `tool_use`
   * and `tool_result`, messages from assistant text, each assistant message's own usage, the plan limit from
   * `rate_limit_event`, and the attempt's usage from the `result` event. A subagent's messages are left out.
   */
  onActivity: (item: ActivityItem) => void = () => undefined;

  /** Takes the next piece of the process's stdout, whole lines or not. */
  write(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  /** The stream has ended. What is left is a last line without its newline: complete if it parses, torn if not. */
  end(): void {
    if (this.pending !== "") this.line(this.pending);
    this.pending = "";
  }

  private line(text: string): void {
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(event)) return;
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.apiKeySource === "string") this.apiKeySource = event.apiKeySource;
    } else if (event.type === "assistant") {
      this.assistant(event);
    } else if (event.type === "user") {
      this.toolResults(event);
    } else if (event.type === "rate_limit_event") {
      this.rateLimit(event);
    } else if (event.type === "result") {
      this.result = event;
      const usage = this.usage();
      if (usage !== null) this.onActivity({ type: "usage", scope: "attempt", usage });
    }
  }

  private assistant(event: Json): void {
    // A subagent's messages say which model it ran, not the one this attempt asked for.
    if (event.parent_tool_use_id) return;
    if (typeof event.error === "string") this.assistantError = event.error;
    const message = isObject(event.message) ? event.message : {};
    const model = message.model;
    // "<synthetic>" is the tool's own error message, not a model's answer.
    const synthetic = model === "<synthetic>";
    if (typeof model === "string" && model.trim() !== "" && !synthetic && !this.models.includes(model)) this.models.push(model);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        this.onActivity({ type: "message", text: block.text });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const input = isObject(block.input) ? block.input : {};
        const call = {
          kind: typeof block.name === "string" ? block.name : null,
          title: TITLE_FIELDS.map((field) => input[field]).find((value): value is string => typeof value === "string") ?? null,
          paths: PATH_FIELDS.map((field) => input[field]).filter((value): value is string => typeof value === "string" && value !== ""),
        };
        this.calls.set(block.id, call);
        this.onActivity({ type: "tool_call", toolCallId: block.id, ...call, status: "in_progress", permission: null });
      }
    }
    if (!synthetic && isObject(message.usage)) this.messageUsage(message.usage, typeof message.id === "string" ? message.id : null);
  }

  /** A message's own usage: that one model call's, not the attempt's so far, so it is never added to another. */
  private messageUsage(usage: Json, id: string | null): void {
    if (id !== null) {
      if (this.usageSeen.has(id)) return;
      this.usageSeen.add(id);
    }
    const inputTokens = count(usage.input_tokens);
    const outputTokens = count(usage.output_tokens);
    const cachedInputTokens = count(usage.cache_read_input_tokens);
    if (![inputTokens, outputTokens, cachedInputTokens].some((value) => value !== null && value > 0)) return;
    const report: UsageReport = {
      source: "claude stream-json assistant message (usage of this message alone, not the attempt so far; input_tokens excludes cache reads and writes)",
      inputTokens,
      outputTokens,
      totalTokens: null,
      cachedInputTokens,
      cost: null,
    };
    this.onActivity({ type: "usage", scope: "message", usage: report });
  }

  /** The `tool_result` blocks of a user message: how each call ended, as Claude Code tells its model. */
  private toolResults(event: Json): void {
    if (event.parent_tool_use_id) return;
    const content = isObject(event.message) && Array.isArray(event.message.content) ? event.message.content : [];
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const call = this.calls.get(block.tool_use_id) ?? { kind: null, title: null, paths: [] };
      this.onActivity({ type: "tool_call", toolCallId: block.tool_use_id, ...call, status: block.is_error === true ? "failed" : "completed", permission: null });
    }
  }

  /** A `rate_limit_event`: the plan limit's status and window as the tool states them. Sent on healthy runs too, so never an error. */
  private rateLimit(event: Json): void {
    const info = isObject(event.rate_limit_info) ? event.rate_limit_info : null;
    if (info === null) return;
    const status = typeof info.status === "string" ? info.status : undefined;
    const window = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
    if (status === undefined && window === undefined) return;
    this.onActivity({ type: "limit", tool: "claude-code", kind: "plan_limit", ...(status === undefined ? {} : { status }), ...(window === undefined ? {} : { window }) });
  }

  /** What the stream said about how the attempt ended. Call after `end`. */
  exit(exitCode: number | null): ParsedExit {
    return {
      reportedOutput: this.output(),
      stopReason: this.stopReason(),
      error: this.error(exitCode),
      reportedModel: this.model(),
      usage: this.usage(),
    };
  }

  private output(): Record<string, OutputFieldValue> {
    const structured = this.result?.structured_output;
    const fields: Record<string, OutputFieldValue> = {};
    if (!isObject(structured)) return fields;
    for (const [name, value] of Object.entries(structured)) {
      if (typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"))) fields[name] = value as OutputFieldValue;
    }
    return fields;
  }

  private stopReason(): StopReason | null {
    const { result } = this;
    if (!result) return null;
    if (result.subtype === "error_max_turns") return "max_turn_requests";
    if (result.stop_reason === "max_tokens") return "max_tokens";
    if (result.stop_reason === "refusal") return "refusal";
    return result.terminal_reason === "completed" ? "end_turn" : null;
  }

  /**
   * Only the closing `result` event and the API error codes on assistant messages say something went wrong: other events
   * (a `rate_limit_event` is sent on healthy runs too) say nothing about how the attempt ended.
   */
  private error(exitCode: number | null): AttemptError | null {
    const { result } = this;
    const failed = result ? result.is_error === true : exitCode !== 0 && this.assistantError !== null;
    if (!failed) return null;
    const kind = (this.assistantError && ERROR_KIND[this.assistantError]) || kindOfStatus(result?.api_error_status) || "agent_error";
    const errors = Array.isArray(result?.errors) ? result.errors.filter((e): e is string => typeof e === "string") : [];
    const message = errors.join("; ") || (typeof result?.result === "string" && result.result) || (this.assistantError ? `Claude Code reported ${this.assistantError}` : "Claude Code reported an error");
    return { kind, message };
  }

  /** The models the tool's own answers named, in order. Not the `init` event's: a login failure has one, and no model ever ran. */
  private model(): string | null {
    const models = this.models.length > 0 ? this.models : this.modelsUsed();
    return models.length > 0 ? models.join(", ") : null;
  }

  private modelsUsed(): string[] {
    const usage = this.result?.modelUsage;
    return isObject(usage) ? Object.keys(usage).filter((model) => model.trim() !== "" && model !== "<synthetic>") : [];
  }

  private usage(): UsageReport | null {
    const { result } = this;
    if (!result || !isObject(result.usage)) return null;
    const inputTokens = count(result.usage.input_tokens);
    const outputTokens = count(result.usage.output_tokens);
    const cachedInputTokens = count(result.usage.cache_read_input_tokens);
    const amount = count(result.total_cost_usd);
    const cacheWrites = count(result.usage.cache_creation_input_tokens);
    const bases = isObject(result.modelUsage)
      ? [...new Set(Object.values(result.modelUsage).map((entry) => (isObject(entry) && typeof entry.costBasis === "string" ? entry.costBasis : null)))]
      : [];
    const parts = [
      "claude stream-json result event (usage, total_cost_usd)",
      // The report has no place for these, so the label says what the numbers leave out.
      "input_tokens excludes cache reads (cachedInputTokens) and cache writes" + (cacheWrites === null ? "" : ` (${cacheWrites} reported, not included)`),
      amount === null ? null : bases.length === 1 && bases[0] === "list" ? "cost is a list-price figure from the tool, not a charge" : bases.length === 1 && bases[0] ? `cost is the tool's own figure, basis "${bases[0]}"` : "cost is the tool's own figure, its basis not stated",
      this.apiKeySource === null ? null : `apiKeySource ${this.apiKeySource}`,
    ];
    const report: UsageReport = {
      source: parts.filter((part) => part !== null).join("; "),
      inputTokens,
      outputTokens,
      totalTokens: null,
      cachedInputTokens,
      cost: amount === null ? null : { amount, currency: "USD" },
    };
    // A block of zeros is what the tool prints when no model ran (a failed login): nothing was used, so nothing is reported.
    const reported = [inputTokens, outputTokens, cachedInputTokens, amount].filter((value) => value !== null);
    return reported.some((value) => value > 0) ? report : null;
  }
}
