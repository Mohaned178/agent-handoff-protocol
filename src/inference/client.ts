// The one place AHP speaks HTTP to a model (ADR 0007): a streamed `/v1/chat/completions` request, timed by AHP's own clock.
// What is measured is time; what is counted is only what the engine reports. Chunks are not tokens: their timing is called
// inter-chunk, and a token count the engine did not report is null, never counted from chunks.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  /** Ending in `/v1`. */
  baseURL: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** OpenAI-style tool schemas, sent as they are (ticket 02's tool-call prompts). */
  tools?: unknown[];
}

export interface StreamChatOptions {
  /** The request is given up, as an error, once it has taken this long. */
  timeoutMs: number;
  /** A clock in milliseconds (default `performance.now`). */
  now?: () => number;
  /** Aborting it gives the request up, as the error `cancelled`. */
  signal?: AbortSignal;
}

/** The token counts of a request exactly as the engine reported them: a count it left out is null. */
export interface ReportedUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

/** A tool call as the stream built it up: the name and the arguments' text, joined from its pieces. */
export interface StreamedToolCall {
  id: string | null;
  name: string | null;
  arguments: string;
}

export interface ChatMeasurement {
  /** Null when the request ran to `[DONE]`; otherwise what went wrong (`HTTP 503: ...`, `timed out after ...`, `cancelled`). */
  error: string | null;
  /** The HTTP status, when a response came. */
  status: number | null;
  /** From sending the request to the first chunk that carried content or a tool call; null if none came. */
  ttftMs: number | null;
  /** The gaps between consecutive chunks that carried content or a tool call. */
  interChunkMs: number[];
  /** From sending the request to its end: `[DONE]`, the error, or the stream's close. */
  latencyMs: number;
  /** How many chunks carried content or a tool call. Not a token count. */
  contentChunks: number;
  /** The `usage` of whichever chunk had one, as reported; null when none did. */
  usage: ReportedUsage | null;
  /** The last `finish_reason` the engine gave, as it gave it. */
  finishReason: string | null;
  /** The answer's text, joined. */
  content: string;
  toolCalls: StreamedToolCall[];
}

/** The body of every bench request beside its model, messages and limit: recorded in `bench_created`. */
export const REQUEST_SETTINGS = { stream: true, includeUsage: true, temperature: 0, seed: 0 } as const;

const BODY_SHOWN = 300;

const round = (ms: number) => Math.round(ms * 1000) / 1000;
const countOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * Sends one streamed chat request and measures it. Never throws for anything the engine or the network does: a status that is
 * not 2xx (with the first 300 characters of the body), a timeout, a cancel, a stream that ends before `[DONE]` or an error
 * the engine streams are all recorded as `error`, with whatever was measured up to there.
 */
export async function streamChat(request: ChatRequest, options: StreamChatOptions): Promise<ChatMeasurement> {
  const now = options.now ?? (() => performance.now());
  const controller = new AbortController();
  let gaveUp: string | null = null;
  const timer = setTimeout(() => {
    gaveUp = `timed out after ${options.timeoutMs} ms`;
    controller.abort();
  }, options.timeoutMs);
  const onAbort = () => {
    gaveUp ??= "cancelled";
    controller.abort();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const measured: Omit<ChatMeasurement, "latencyMs"> = { error: null, status: null, ttftMs: null, interChunkMs: [], contentChunks: 0, usage: null, finishReason: null, content: "", toolCalls: [] };
  const calls = new Map<number, StreamedToolCall>();
  let lastChunkAt: number | null = null;
  const started = now();
  try {
    const response = await fetch(`${request.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        stream: REQUEST_SETTINGS.stream,
        stream_options: { include_usage: REQUEST_SETTINGS.includeUsage },
        temperature: REQUEST_SETTINGS.temperature,
        max_tokens: request.maxTokens,
        seed: REQUEST_SETTINGS.seed,
      }),
      signal: controller.signal,
    });
    measured.status = response.status;
    if (!response.ok || !response.body) {
      const body = await response.text();
      measured.error = `HTTP ${response.status}: ${body.slice(0, BODY_SHOWN)}`;
      return { ...measured, latencyMs: round(now() - started) };
    }
    let done = false;
    let buffered = "";
    const decoder = new TextDecoder();
    const onLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice("data:".length).trim();
      if (data === "[DONE]") {
        done = true;
        return;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (chunk.error !== undefined) {
        const error = chunk.error as { message?: unknown } | string;
        measured.error = `the engine streamed an error: ${String(typeof error === "object" && error !== null ? (error.message ?? JSON.stringify(error)) : error).slice(0, BODY_SHOWN)}`;
      }
      if (isObject(chunk.usage)) measured.usage = { promptTokens: countOrNull(chunk.usage.prompt_tokens), completionTokens: countOrNull(chunk.usage.completion_tokens) };
      let carries = false;
      for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
        if (!isObject(choice)) continue;
        if (typeof choice.finish_reason === "string") measured.finishReason = choice.finish_reason;
        const delta = isObject(choice.delta) ? choice.delta : {};
        if (typeof delta.content === "string" && delta.content !== "") {
          measured.content += delta.content;
          carries = true;
        }
        for (const piece of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (!isObject(piece)) continue;
          carries = true;
          const index = typeof piece.index === "number" ? piece.index : 0;
          const call = calls.get(index) ?? { id: null, name: null, arguments: "" };
          if (typeof piece.id === "string") call.id = piece.id;
          const fn = isObject(piece.function) ? piece.function : {};
          if (typeof fn.name === "string") call.name = (call.name ?? "") + fn.name;
          if (typeof fn.arguments === "string") call.arguments += fn.arguments;
          calls.set(index, call);
        }
      }
      if (carries) {
        const at = now();
        if (lastChunkAt === null) measured.ttftMs = round(at - started);
        else measured.interChunkMs.push(round(at - lastChunkAt));
        lastChunkAt = at;
        measured.contentChunks += 1;
      }
    };
    for await (const bytes of response.body as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(bytes, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        onLine(buffered.slice(0, newline).replace(/\r$/, ""));
        buffered = buffered.slice(newline + 1);
        if (done) break;
      }
      if (done) break;
    }
    if (!done && buffered !== "") onLine(buffered);
    if (!done && measured.error === null) measured.error = "the stream ended before [DONE]";
  } catch (error) {
    measured.error = gaveUp ?? `request failed: ${describe(error)}`;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    measured.toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  }
  // A timeout or cancel that cut the stream short is the error, not the stream's end it caused.
  if (gaveUp) measured.error = gaveUp;
  return { ...measured, latencyMs: round(now() - started) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An error's message with its cause's, which is where Node's fetch puts the reason (`ECONNREFUSED`). */
export function describe(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const detail = cause?.code ?? cause?.message;
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}
