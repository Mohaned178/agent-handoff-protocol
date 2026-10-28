// Reads what OpenCode says during one `session/prompt` turn, in the ACP messages seen from a real 1.18.35 (ticket 18):
// `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`,
// `usage_update`, and others that are ignored) and the prompt's result. Nothing is derived from output length or time: a
// number the tool did not state is absent.

import type { AdapterErrorKind, AttemptError, OutputFieldValue, StopReason, UsageReport } from "../../protocol/index.ts";
import { STOP_REASONS } from "../../protocol/index.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A tool call as OpenCode has described it so far: each `tool_call_update` fills in or replaces what it carries. */
export interface ToolCall {
  toolCallId: string;
  kind: string | null;
  title: string | null;
  status: string | null;
  paths: string[];
  /** The shell command of an `execute` call. */
  command: string | null;
}

/** Keeps a message from a tool, or a secret that got into one, from being copied whole into the ledger. */
const MAX_ERROR_CHARS = 500;

/** An API key in a message (a masked one too) is not repeated: this record is public. */
export function redacted(message: string): string {
  const clean = message.replace(/\bsk-[\w*-]+/g, "sk-[redacted]").replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]");
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}

/**
 * The class of a failure by what the tool said, since OpenCode's errors carry a JSON-RPC code (-32602 for a bad
 * parameter such as a model it does not list: seen; -32603 for anything inside it: seen) and the provider's own text, and no
 * HTTP status. A rejected key is `config_auth` (seen); a rate limit or an overload is `transient` and a quota or a
 * payment problem is not, since waiting does not clear it (by what those messages mean, not seen from OpenCode).
 */
export function classify(message: string, code: number | null = null): AdapterErrorKind {
  if (code === -32602 && /model not found/i.test(message)) return "config_auth";
  if (/\b(401|403)\b|api key|unauthori[sz]ed|forbidden|not logged in|log in|login|credential|authenticat/i.test(message)) return "config_auth";
  if (/\b402\b|quota|insufficient|billing|payment|funds|usage limit/i.test(message)) return "agent_error";
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
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const chunk = isObject(update.content) && update.content.type === "text" ? text(update.content.text) : null;
        if (chunk === null) return;
        const id = text(update.messageId) ?? "";
        this.messages.set(id, (this.messages.get(id) ?? "") + chunk);
        this.answeredSeen = true;
        return;
      }
      case "agent_thought_chunk":
        this.answeredSeen = true;
        return;
      case "tool_call":
      case "tool_call_update":
        this.toolCallUpdate(update);
        return;
      case "usage_update":
        if (isObject(update.cost)) this.costBlock = update.cost;
        return;
    }
  }

  private toolCallUpdate(update: Json): void {
    const id = text(update.toolCallId);
    if (id === null) return;
    this.answeredSeen = true;
    const known = this.calls.get(id) ?? { toolCallId: id, kind: null, title: null, status: null, paths: [], command: null };
    const locations = Array.isArray(update.locations) ? update.locations.flatMap((location) => (isObject(location) && typeof location.path === "string" ? [location.path] : [])) : [];
    const rawInput = isObject(update.rawInput) ? update.rawInput : {};
    const call: ToolCall = {
      toolCallId: id,
      kind: text(update.kind) ?? known.kind,
      title: text(update.title) ?? known.title,
      status: text(update.status) ?? known.status,
      paths: locations.length > 0 ? locations : known.paths,
      command: text(rawInput.command) ?? known.command,
    };
    this.calls.set(id, call);
    this.onToolCall(call);
  }

  /** The `session/prompt` result: how the turn ended, and what it used. */
  finish(result: unknown): void {
    if (!isObject(result)) return;
    this.stopSeen = text(result.stopReason);
    if (isObject(result.usage)) this.usageBlock = result.usage;
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
      error = { kind: "agent_error", message: `OpenCode ended without finishing the turn (exit code ${exitCode ?? "none"})` };
    }
    return { reportedOutput: cancelled || error ? {} : this.output(), stopReason, error, usage: this.usage() };
  }

  /** The last message, when it is the JSON object the prompt asked for (alone or in a code fence). Anything it said before is narration. */
  private output(): Record<string, OutputFieldValue> {
    const fields: Record<string, OutputFieldValue> = {};
    const last = [...this.messages.values()].at(-1);
    if (last === undefined) return fields;
    const structured = objectIn(last);
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

/** The JSON object a message is, or the one in its last code fence; null when it is neither. */
function objectIn(message: string): Json | null {
  const candidates = [message.trim()];
  for (const fence of message.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) candidates.push(fence[1]!.trim());
  for (const candidate of candidates.reverse()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isObject(parsed)) return parsed;
    } catch {
      // not this one
    }
  }
  return null;
}
