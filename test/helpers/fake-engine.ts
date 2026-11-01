// A fake inference engine for the bench's tests: a `node:http` server on a free port that serves `/v1/models`, a version
// path and a streamed `/v1/chat/completions` from scripted answers. It is never evidence of anything an engine does.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** One scripted answer to a chat request. */
export type FakeChat =
  | {
      /** Content pieces, each sent as its own SSE event after waiting `delayMs`. */
      chunks: { delayMs?: number; content?: string; toolCall?: { id?: string; name?: string; arguments?: string } }[];
      /** Sent in a last chunk with no choices, as engines do when `stream_options.include_usage` is set. Omitted: no usage chunk. */
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      /** Waited before the response's headers are sent. */
      headerDelayMs?: number;
      /** Leave out the final `data: [DONE]`. */
      omitDone?: boolean;
      finishReason?: string;
    }
  | { status: number; body: string }
  /** Never answers: the response is held open until the client gives up. */
  | { stall: true };

export interface FakeEngineScript {
  /** The models `/v1/models` lists; a status and body instead make it fail. */
  models?: string[] | { status: number; body: string };
  /** The path on the origin that answers with `{ version }`, and the version; null answers 404 everywhere. */
  version?: { path: string; version: string } | null;
  /** The answer to the n-th chat request (from 0), given its parsed body. */
  chat: (body: Record<string, unknown>, index: number) => FakeChat;
}

export interface FakeEngine {
  /** `http://127.0.0.1:<port>/v1` */
  baseURL: string;
  /** Every chat request's parsed body, in the order they arrived. */
  chatBodies: Record<string, unknown>[];
  /** The most chat requests that were being answered at once. */
  maxInFlight: () => number;
  close: () => Promise<void>;
}

export async function startFakeEngine(script: FakeEngineScript): Promise<FakeEngine> {
  const chatBodies: Record<string, unknown>[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const open = new Set<ServerResponse>();

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    open.add(response);
    response.on("close", () => open.delete(response));
    const url = new URL(request.url ?? "/", "http://localhost");
    const body = await readBody(request);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      const models = script.models ?? ["fake-model"];
      if (!Array.isArray(models)) return send(response, models.status, models.body);
      return send(response, 200, JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
    }
    const version = script.version === undefined ? { path: "/version", version: "0.0.0-fake" } : script.version;
    if (request.method === "GET" && version && url.pathname === version.path) return send(response, 200, JSON.stringify({ version: version.version }));
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const index = chatBodies.length;
      chatBodies.push(parsed);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await answer(response, script.chat(parsed, index));
      } finally {
        inFlight -= 1;
      }
      return;
    }
    send(response, 404, "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    chatBodies,
    maxInFlight: () => maxInFlight,
    close: async () => {
      for (const response of open) response.destroy();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // fetch keeps idle connections alive, which `close` would otherwise wait out.
      server.closeAllConnections();
      await closed;
    },
  };
}

/** A base URL on which nothing listens: a port that was free a moment ago. */
export async function closedBaseURL(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": status === 200 ? "application/json" : "text/plain" });
  response.end(body);
}

async function answer(response: ServerResponse, chat: FakeChat): Promise<void> {
  if ("stall" in chat) {
    await new Promise<void>((resolve) => response.on("close", () => resolve()));
    return;
  }
  if ("status" in chat) return send(response, chat.status, chat.body);
  if (chat.headerDelayMs) await sleep(chat.headerDelayMs);
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
  // The role chunk with empty content, as vLLM sends it first: it carries nothing, so it is no first token.
  event({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  for (const [i, chunk] of chat.chunks.entries()) {
    if (chunk.delayMs) await sleep(chunk.delayMs);
    if (response.destroyed) return;
    const delta: Record<string, unknown> = {};
    if (chunk.content !== undefined) delta.content = chunk.content;
    if (chunk.toolCall) delta.tool_calls = [{ index: 0, id: chunk.toolCall.id, type: "function", function: { name: chunk.toolCall.name, arguments: chunk.toolCall.arguments } }];
    const last = i === chat.chunks.length - 1;
    event({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: last ? (chat.finishReason ?? "stop") : null }] });
  }
  if (chat.usage) event({ id: "fake", object: "chat.completion.chunk", choices: [], usage: chat.usage });
  if (!chat.omitDone) response.write("data: [DONE]\n\n");
  response.end();
}

/** An answer of `pieces` content chunks, `delayMs` apart, with the usage an engine would report (or none). */
export const streamed = (pieces: number, delayMs: number, usage: { prompt_tokens?: number; completion_tokens?: number } | null = { prompt_tokens: 10, completion_tokens: pieces }): FakeChat => ({
  chunks: Array.from({ length: pieces }, (_, i) => ({ delayMs, content: `t${i} ` })),
  usage,
});
