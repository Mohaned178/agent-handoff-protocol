// Reads the stream `codex exec --json` prints: one JSON object per line. Codex adds event and item types between
// versions, so only what the adapter needs is looked at and every other line is ignored; a line that is not JSON (the
// torn last line of a killed process) is ignored too. Nothing here is derived from output length or time: a number the
// tool did not state is absent.
//
// Seen on a real 0.146.0 (ticket 16): `thread.started` (the thread id), `turn.started`, `item.started` and `item.completed`
// (`agent_message`, `command_execution`, `error`), `error`, `turn.completed` (the usage) and `turn.failed`. Only
// `turn.failed` ends a turn badly: the top-level `error` events before it are retry notices ("Reconnecting... 2/5") too.

import type { AdapterErrorKind, AttemptError, OutputFieldValue, StopReason, UsageReport } from "../../protocol/index.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/** What an error message says about its HTTP status and error code: either a JSON body (`{"status":400,"error":{"code":...}}`) or Codex's own text ("unexpected status 401 Unauthorized: ..."). */
function causeOf(message: string): { status: number | null; code: string | null } {
  try {
    const body: unknown = JSON.parse(message);
    if (isObject(body)) {
      const error = isObject(body.error) ? body.error : {};
      return { status: count(body.status), code: typeof error.code === "string" ? error.code : null };
    }
  } catch {
    // not a JSON body
  }
  const status = /\bstatus (\d{3})\b/.exec(message)?.[1];
  return { status: status === undefined ? null : Number(status), code: null };
}

/**
 * The class of a failed turn. A 401 (a missing login: seen) and `model_not_found` (a model the login cannot use: seen)
 * are `config_auth`, and so is a quota or usage limit (a 429 that waiting does not clear; seen as plain text, "You've
 * hit your usage limit. ... try again at <date>"): retrying it only spends attempts, and the person must change their
 * plan or wait. A timeout, a 429 and a 5xx are `transient` by what those statuses mean (not seen from Codex); anything
 * else is the agent's own error.
 */
function kindOf(message: string): AdapterErrorKind {
  const { status, code } = causeOf(message);
  if (status === 401 || code === "model_not_found") return "config_auth";
  if (code === "insufficient_quota" || code === "usage_limit_reached" || /usage limit|insufficient.quota/i.test(message)) return "config_auth";
  if (status !== null && (status === 408 || status === 429 || status >= 500)) return "transient";
  return "agent_error";
}

export interface ParsedExit {
  reportedOutput: Record<string, OutputFieldValue>;
  stopReason: StopReason | null;
  error: AttemptError | null;
  usage: UsageReport | null;
}

export class CodexStream {
  private threadIdSeen: string | null = null;
  private lastMessage: string | null = null;
  private answeredSeen = false;
  private turnCompleted = false;
  private usageBlock: Json | null = null;
  private failure: string | null = null;
  private lastError: string | null = null;
  private pending = "";

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

  /** The id of the thread Codex started, which names its session file; null until `thread.started`. */
  get threadId(): string | null {
    return this.threadIdSeen;
  }

  /** Whether the model produced anything (a message or a command): a turn that failed before that ran no model. */
  get answered(): boolean {
    return this.answeredSeen;
  }

  private line(text: string): void {
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(event)) return;
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") this.threadIdSeen = event.thread_id;
        break;
      case "item.completed":
        this.item(event.item);
        break;
      case "turn.completed":
        this.turnCompleted = true;
        if (isObject(event.usage)) this.usageBlock = event.usage;
        this.answeredSeen = true;
        break;
      case "turn.failed":
        this.failure = isObject(event.error) && typeof event.error.message === "string" ? event.error.message : "Codex reported a failed turn";
        break;
      case "error":
        if (typeof event.message === "string" && !/^Reconnecting\.\.\./.test(event.message)) this.lastError = event.message;
        break;
    }
  }

  private item(item: unknown): void {
    if (!isObject(item)) return;
    if (item.type === "agent_message" && typeof item.text === "string") {
      this.lastMessage = item.text;
      this.answeredSeen = true;
    } else if (item.type === "command_execution") {
      this.answeredSeen = true;
    }
  }

  /** What the stream said about how the attempt ended. Call after `end`. */
  exit(exitCode: number | null): ParsedExit {
    return { reportedOutput: this.output(), stopReason: this.turnCompleted ? "end_turn" : null, error: this.error(exitCode), usage: this.usage() };
  }

  /** The last message, when it is the JSON object `--output-schema` asked for. Anything else it said is narration. */
  private output(): Record<string, OutputFieldValue> {
    const fields: Record<string, OutputFieldValue> = {};
    if (this.lastMessage === null || !this.turnCompleted) return fields;
    let structured: unknown;
    try {
      structured = JSON.parse(this.lastMessage);
    } catch {
      return fields;
    }
    if (!isObject(structured)) return fields;
    for (const [name, value] of Object.entries(structured)) {
      if (typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"))) fields[name] = value as OutputFieldValue;
    }
    return fields;
  }

  private error(exitCode: number | null): AttemptError | null {
    const message = this.failure ?? (exitCode !== null && exitCode !== 0 ? this.lastError : null);
    if (message === null) return null;
    return { kind: kindOf(message), message };
  }

  private usage(): UsageReport | null {
    const usage = this.usageBlock;
    if (!usage) return null;
    const inputTokens = count(usage.input_tokens);
    const outputTokens = count(usage.output_tokens);
    const cachedInputTokens = count(usage.cached_input_tokens);
    const cacheWrites = count(usage.cache_write_input_tokens);
    const reasoning = count(usage.reasoning_output_tokens);
    const parts = [
      "codex exec --json turn.completed event (usage)",
      // The report has no place for these two, and no total or cost: the label says what the numbers include.
      "input_tokens includes cached_input_tokens" + (!cacheWrites ? "" : `, and ${cacheWrites} cache writes were reported, not added`),
      reasoning === null ? null : `${reasoning} reasoning_output_tokens were reported, not added`,
      "no total or cost is reported",
    ];
    const report: UsageReport = {
      source: parts.filter((part) => part !== null).join("; "),
      inputTokens,
      outputTokens,
      totalTokens: null,
      cachedInputTokens,
      cost: null,
    };
    // A block of zeros says nothing was used, so nothing is reported.
    const reported = [inputTokens, outputTokens, cachedInputTokens].filter((value) => value !== null);
    return reported.some((value) => value > 0) ? report : null;
  }
}
