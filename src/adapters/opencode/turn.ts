// Reads what OpenCode says during one `session/prompt` turn, in the ACP messages seen from a real 1.18.35 (ticket 18):
// `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`,
// `usage_update`, and others that are ignored) and the prompt's result. Nothing is derived from output length or time: a
// number the tool did not state is absent.

import type { ActivityLimit, AdapterErrorKind, AttemptError, OutputFieldValue, StopReason, UsageReport } from "../../protocol/index.ts";
import { STOP_REASONS } from "../../protocol/index.ts";
import type { ActivityItem } from "../activity.ts";
import { mergeToolCall, type ToolCall } from "../acp/tool-calls.ts";
import { jsonObjectIn } from "../prompt.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The class of a failure by what the tool said, since OpenCode's errors carry a JSON-RPC code (-32602 for a bad
 * parameter such as a model it does not list: seen; -32603 for anything inside it: seen) and the provider's own text, and no
 * HTTP status. A rejected key is `config_auth` (seen); a rate limit or an overload is `transient`, and a quota, a usage
 * limit or a payment problem is `config_auth`, since retrying only spends attempts (by what those messages mean, not seen
 * from OpenCode).
 */
export function classify(message: string, code: number | null = null): AdapterErrorKind {
  if (code === -32602 && /model not found/i.test(message)) return "config_auth";
  if (/\b(401|403)\b|api key|unauthori[sz]ed|forbidden|not logged in|log in|login|credential|authenticat/i.test(message)) return "config_auth";
  if (/\b402\b|quota|insufficient|billing|payment|funds|usage limit/i.test(message)) return "config_auth";
  if (/\b(408|429|50[0-9])\b|rate.?limit|too many requests|overloaded|unavailable|timed? ?out|temporar|ECONNRESET|ETIMEDOUT/i.test(message)) return "transient";
  return "agent_error";
}

export interface ParsedExit {
  reportedOutput: Record<string, OutputFieldValue>;
  stopReason: StopReason | null;
  error: AttemptError | null;
  usage: UsageReport | null;
}

export class AcpTurn {
  private readonly messages = new Map<string, string>();
  private readonly calls = new Map<string, ToolCall>();
  private usageBlock: Json | null = null;
  private costBlock: Json | null = null;
  private stopSeen: string | null = null;
  private failure: AttemptError | null = null;
  private answeredSeen = false;

  /** Called each time OpenCode says something about a tool call, with what is known of it by then. */
  onToolCall: (call: ToolCall) => void = () => undefined;
  /** Called with each message once it is whole (the next update is not one of its chunks), with what OpenCode reported using, and with its context window. */
  onActivity: (item: Extract<ActivityItem, { type: "message" | "usage" }> | { type: "limit"; limit: Omit<ActivityLimit, "tool"> }) => void = () => undefined;
  /** The message whose chunks are arriving, not yet passed to `onActivity`. */
  private speaking: string | null = null;

  /** Whether the model produced anything (a thought, a message or a tool call): a turn that failed before that ran no model. */
  get answered(): boolean {
    return this.answeredSeen;
  }

  /** The tool calls seen so far, by their ID. */
  toolCall(id: string): ToolCall | undefined {
    return this.calls.get(id);
  }

  /** A `session/update` notification's params. Anything not recognised is ignored: OpenCode adds update kinds between versions. */
  update(params: unknown): void {
    if (!isObject(params) || !isObject(params.update)) return;
    const update = params.update;
    if (update.sessionUpdate === "agent_message_chunk") {
      const chunk = isObject(update.content) && update.content.type === "text" ? text(update.content.text) : null;
      if (chunk === null) return;
      const id = text(update.messageId) ?? "";
      if (this.speaking !== id) this.flushMessage();
      this.speaking = id;
      this.messages.set(id, (this.messages.get(id) ?? "") + chunk);
      this.answeredSeen = true;
      return;
    }
    // Anything else OpenCode says ends the message it was saying.
    this.flushMessage();
    switch (update.sessionUpdate) {
      case "agent_thought_chunk":
        this.answeredSeen = true;
        return;
      case "tool_call":
      case "tool_call_update":
        this.toolCallUpdate(update);
        return;
      case "usage_update":
        this.usageUpdate(update);
        return;
    }
  }

  /** The message being said, whole, to `onActivity`. */
  private flushMessage(): void {
    if (this.speaking === null) return;
    const said = this.messages.get(this.speaking) ?? "";
    this.speaking = null;
    this.onActivity({ type: "message", text: said });
  }

  /**
   * A `usage_update`: the context window (`used` of `size` tokens) as a limit, and its cost so far as usage when it is
   * above zero (a zero is what OpenCode says for a model it does not price, a local engine's included). It carries no
   * token counts of the attempt's, so none are reported from it.
   */
  private usageUpdate(update: Json): void {
    if (isObject(update.cost)) this.costBlock = update.cost;
    const used = count(update.used);
    const size = count(update.size);
    if (used !== null || size !== null) {
      this.onActivity({ type: "limit", limit: { kind: "context_window", ...(used === null ? {} : { used }), ...(size === null ? {} : { size }) } });
    }
    const amount = isObject(update.cost) ? count(update.cost.amount) : null;
    const currency = isObject(update.cost) ? text(update.cost.currency) : null;
    if (amount !== null && amount > 0 && currency !== null && currency.trim() !== "") {
      const usage: UsageReport = {
        source: "opencode acp usage_update (cost so far; it carries no token counts, which come with the turn's result)",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cachedInputTokens: null,
        cost: { amount, currency },
      };
      this.onActivity({ type: "usage", scope: "attempt", usage });
    }
  }

  private toolCallUpdate(update: Json): void {
    const call = mergeToolCall(update, typeof update.toolCallId === "string" ? this.calls.get(update.toolCallId) : undefined);
    if (call === null) return;
    this.answeredSeen = true;
    this.calls.set(call.toolCallId, call);
    this.onToolCall(call);
  }

  /** The `session/prompt` result: how the turn ended, and what it used. */
  finish(result: unknown): void {
    this.flushMessage();
    if (!isObject(result)) return;
    this.stopSeen = text(result.stopReason);
    if (isObject(result.usage)) this.usageBlock = result.usage;
    const usage = this.usage();
    if (usage !== null) this.onActivity({ type: "usage", scope: "attempt", usage });
  }

  /** The turn failed: the first failure is kept, as the cause of the later ones. */
  fail(error: AttemptError): void {
    this.failure ??= error;
  }

  /** What the turn amounted to. `cancelled` is a turn AHP stopped: its stop reason is not a result, and nothing it lacks is an error. */
  exit(cancelled: boolean, exitCode: number | null): ParsedExit {
    this.flushMessage();
    const stopReason = (STOP_REASONS as readonly string[]).includes(this.stopSeen ?? "") ? (this.stopSeen as StopReason) : null;
    let error = this.failure;
    if (error === null && !cancelled && this.stopSeen === null) {
      error = { kind: "agent_error", message: `OpenCode ended without finishing the turn (exit code ${exitCode ?? "none"})` };
    }
    return { reportedOutput: cancelled || error ? {} : this.output(), stopReason, error, usage: this.usage() };
  }

  /** The last message, when it is the JSON object the prompt asked for (alone or in a code fence). Anything it said before is narration. */
  private output(): Record<string, OutputFieldValue> {
    const fields: Record<string, OutputFieldValue> = {};
    const last = [...this.messages.values()].at(-1);
    if (last === undefined) return fields;
    const structured = jsonObjectIn(last);
    if (structured === null) return fields;
    for (const [name, value] of Object.entries(structured)) {
      if (typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"))) fields[name] = value as OutputFieldValue;
    }
    return fields;
  }

  private usage(): UsageReport | null {
    const usage = this.usageBlock;
    if (!usage) return null;
    const inputTokens = count(usage.inputTokens);
    const outputTokens = count(usage.outputTokens);
    const totalTokens = count(usage.totalTokens);
    const cachedInputTokens = count(usage.cachedReadTokens);
    const thought = count(usage.thoughtTokens);
    const cacheWrites = count(usage.cachedWriteTokens);
    // A cost of 0 is what OpenCode reports for a model it does not price (a free one, or one billed to a subscription),
    // so it is not taken for a report that nothing was charged.
    const amount = this.costBlock ? count(this.costBlock.amount) : null;
    const currency = this.costBlock ? text(this.costBlock.currency) : null;
    const cost = amount !== null && amount > 0 && currency !== null && currency.trim() !== "" ? { amount, currency } : null;
    const parts = [
      "opencode acp session/prompt result (usage)",
      "inputTokens excludes cachedReadTokens, and totalTokens is input + output + thought + cached read",
      thought === null ? null : `${thought} thoughtTokens were reported, included in totalTokens only`,
      !cacheWrites ? null : `${cacheWrites} cachedWriteTokens were reported, not added`,
      cost === null ? "no cost reported (a zero cost is not taken as one)" : "cost is the last usage_update's",
    ];
    const reported = [inputTokens, outputTokens, totalTokens, cachedInputTokens].filter((value) => value !== null);
    // A block of zeros says nothing was used (a cancelled turn is one), so nothing is reported.
    if (!reported.some((value) => value > 0) && cost === null) return null;
    return { source: parts.filter((part) => part !== null).join("; "), inputTokens, outputTokens, totalTokens, cachedInputTokens, cost };
  }
}
