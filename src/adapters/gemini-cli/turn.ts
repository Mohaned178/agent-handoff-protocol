// Reads what Gemini CLI says during one `session/prompt` turn of `gemini --acp`. Two messages of this protocol were seen
// from a real 0.42.0 (`initialize`, and `session/new` with no login); the rest is read from the tool's own source (ticket
// 19, no paid access to run a turn): `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`,
// `tool_call`, `tool_call_update`; others are ignored) and the prompt's result, whose `_meta.quota` is the tool's usage.
// Nothing is derived from output length or time: a number the tool did not state is absent.

import type { AdapterErrorKind, AttemptError, OutputFieldValue, StopReason, UsageReport } from "../../protocol/index.ts";
import { STOP_REASONS } from "../../protocol/index.ts";
import { mergeToolCall, type ToolCall } from "../acp/tool-calls.ts";
import { jsonObjectIn } from "../prompt.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Gemini CLI says this in a message chunk when the approval mode changes (source); it is not the agent speaking. */
const MODE_UPDATE = "[MODE_UPDATE]";

/**
 * The class of a failure. Gemini CLI puts an HTTP status in the JSON-RPC `code` of a failed prompt (source: 429 for a
 * rate limit, the API's own status for others), and uses -32000 for a session it could not start (seen, for a missing
 * key). A session that could not start is `config_auth`: no model ran. A 500 is what the tool reports for any error it
 * cannot name, so it is not taken for an outage that waiting clears; 502 to 504, 408 and 429 are `transient`. A 404 is a
 * model this login cannot use. Otherwise the message decides: a quota, usage limit or payment problem is `config_auth`, since retrying only spends attempts.
 */
export function classify(message: string, code: number | null = null, phase: "session" | "prompt" = "prompt"): AdapterErrorKind {
  if (phase === "session") return "config_auth";
  if (code === 401 || code === 403 || code === 404) return "config_auth";
  if (code === 408 || code === 429 || code === 502 || code === 503 || code === 504) return "transient";
  if (/\b(401|403)\b|api key|unauthori[sz]ed|forbidden|not logged in|log in|login|credential|authenticat|permission denied|PERMISSION_DENIED/i.test(message)) return "config_auth";
  if (/\b402\b|insufficient|billing|payment|funds|usage limit/i.test(message)) return "config_auth";
  if (/rate.?limit|too many requests|overloaded|unavailable|timed? ?out|temporar|ECONNRESET|ETIMEDOUT/i.test(message)) return "transient";
  return "agent_error";
}

export interface ParsedExit {
  reportedOutput: Record<string, OutputFieldValue>;
  stopReason: StopReason | null;
  error: AttemptError | null;
  usage: UsageReport | null;
  /** The model the tool attributes the turn's tokens to, when that is one name; null otherwise. */
  reportedModel: string | null;
}

export class GeminiTurn {
  /** The agent's messages, one per stretch of text between tool calls: Gemini's chunks carry no message ID. */
  private readonly messages: string[] = [];
  private startNewMessage = true;
  private readonly calls = new Map<string, ToolCall>();
  private quota: Json | null = null;
  private stopSeen: string | null = null;
  private failure: AttemptError | null = null;
  private answeredSeen = false;

  /** Called each time Gemini CLI says something about a tool call, with what is known of it by then. */
  onToolCall: (call: ToolCall) => void = () => undefined;

  /** Whether the model produced anything (a thought, a message or a tool call): a turn that failed before that ran no model. */
  get answered(): boolean {
    return this.answeredSeen;
  }

  /** The tool calls seen so far, by their ID. */
  toolCall(id: string): ToolCall | undefined {
    return this.calls.get(id);
  }

  /** A `session/update` notification's params. Anything not recognised is ignored: the tool adds update kinds between versions. */
  update(params: unknown): void {
    if (!isObject(params) || !isObject(params.update)) return;
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const chunk = isObject(update.content) && update.content.type === "text" ? text(update.content.text) : null;
        if (chunk === null || chunk.startsWith(MODE_UPDATE)) return;
        if (this.startNewMessage) {
          this.messages.push("");
          this.startNewMessage = false;
        }
        this.messages[this.messages.length - 1] += chunk;
        this.answeredSeen = true;
        return;
      }
      case "agent_thought_chunk":
        this.answeredSeen = true;
        return;
      case "tool_call":
      case "tool_call_update": {
        const call = mergeToolCall(update, typeof update.toolCallId === "string" ? this.calls.get(update.toolCallId) : undefined);
        if (call === null) return;
        this.answeredSeen = true;
        // What the agent says after a tool call is a new message: only the last one can be the report.
        this.startNewMessage = true;
        this.calls.set(call.toolCallId, call);
        this.onToolCall(call);
        return;
      }
    }
  }

  /** The `session/prompt` result: how the turn ended, and the tool's own account of what it used. */
  finish(result: unknown): void {
    if (!isObject(result)) return;
    this.stopSeen = text(result.stopReason);
    if (isObject(result._meta) && isObject(result._meta.quota)) this.quota = result._meta.quota;
  }

  /** The turn failed: the first failure is kept, as the cause of the later ones. */
  fail(error: AttemptError): void {
    this.failure ??= error;
  }

  /** What the turn amounted to. `cancelled` is a turn AHP stopped: its stop reason is not a result, and nothing it lacks is an error. */
  exit(cancelled: boolean, exitCode: number | null): ParsedExit {
    const stopReason = (STOP_REASONS as readonly string[]).includes(this.stopSeen ?? "") ? (this.stopSeen as StopReason) : null;
    let error = this.failure;
    if (error === null && !cancelled && this.stopSeen === null) {
      error = { kind: "agent_error", message: `Gemini CLI ended without finishing the turn (exit code ${exitCode ?? "none"})` };
    }
    return { reportedOutput: cancelled || error ? {} : this.output(), stopReason, error, usage: this.usage(), reportedModel: this.model() };
  }

  /** The last message, when it is the JSON object the prompt asked for (alone or in a code fence). Anything it said before is narration. */
  private output(): Record<string, OutputFieldValue> {
    const fields: Record<string, OutputFieldValue> = {};
    const last = this.messages.at(-1);
    if (last === undefined) return fields;
    const structured = jsonObjectIn(last);
    if (structured === null) return fields;
    for (const [name, value] of Object.entries(structured)) {
      if (typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"))) fields[name] = value as OutputFieldValue;
    }
    return fields;
  }

  /**
   * The models the tool attributes tokens to (`_meta.quota.model_usage`). The tool files a later model call of a turn
   * under its configured model when it did not name the model that answered (source), so the name is reported only when
   * every call is under one: with two or more, which one answered is not known, and none is claimed.
   */
  private model(): string | null {
    const usage = this.quota && Array.isArray(this.quota.model_usage) ? this.quota.model_usage : [];
    const names = new Set(usage.flatMap((entry) => (isObject(entry) && typeof entry.model === "string" && entry.model.trim() !== "" ? [entry.model] : [])));
    return names.size === 1 ? [...names][0]! : null;
  }

  private usage(): UsageReport | null {
    const tokens = this.quota && isObject(this.quota.token_count) ? this.quota.token_count : null;
    if (!tokens) return null;
    const inputTokens = count(tokens.input_tokens);
    const outputTokens = count(tokens.output_tokens);
    // A block of zeros says nothing was used (a slash command is answered without a model), so nothing is reported.
    if (![inputTokens, outputTokens].some((value) => value !== null && value > 0)) return null;
    return {
      source:
        "gemini acp session/prompt result _meta.quota.token_count; the tool sums its model calls of the turn: input is its promptTokenCount " +
        "and output its candidatesTokenCount, so thought tokens are in neither and cached tokens are not separated; no total and no cost reported",
      inputTokens,
      outputTokens,
      totalTokens: null,
      cachedInputTokens: null,
      cost: null,
    };
  }
}
