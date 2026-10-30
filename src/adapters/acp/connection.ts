// A minimal Agent Client Protocol connection over an agent's stdio: JSON-RPC 2.0 messages, one per line. AHP is the
// client. This is the whole of the protocol machinery the ACP adapter (OpenCode) needs (requests, responses, notifications,
// and requests from the agent); what the messages mean is the adapter's. No third-party bridge is involved (ticket 18).

import type { Readable, Writable } from "node:stream";

/** A JSON-RPC error: the agent's answer to a request, or what AHP answers to one of the agent's. */
export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

/** The agent's output ended (or its stdin could not be written) before the request was answered. */
export class ConnectionClosedError extends Error {
  constructor() {
    super("the agent's connection closed before it answered");
    this.name = "ConnectionClosedError";
  }
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export interface AcpHandlers {
  /** A notification from the agent (`session/update`). */
  notification?: (method: string, params: unknown) => void;
  /**
   * A request from the agent (`session/request_permission`, `fs/write_text_file`). Return its result; throw an
   * `AcpError` to answer with that error. Returning `undefined` answers "method not found": AHP offers the agent
   * nothing it did not declare, and an unanswered request would leave the agent waiting for ever.
   */
  request?: (method: string, params: unknown) => Promise<unknown>;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export class AcpConnection {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private pending = "";
  private open = true;
  /** Settles once the agent's output has ended. */
  readonly closed: Promise<void>;

  private readonly output: Writable;
  private readonly handlers: AcpHandlers;

  constructor(input: Readable, output: Writable, handlers: AcpHandlers) {
    this.output = output;
    this.handlers = handlers;
    // Writing to a process that has gone is an EPIPE; the connection closing is how the adapter learns of it.
    output.on("error", () => undefined);
    input.setEncoding("utf8");
    this.closed = new Promise<void>((resolve) => {
      const finish = () => {
        if (!this.open) return;
        if (this.pending.trim() !== "") this.line(this.pending);
        this.pending = "";
        this.open = false;
        for (const { reject } of this.waiting.values()) reject(new ConnectionClosedError());
        this.waiting.clear();
        resolve();
      };
      input.on("data", (chunk: string) => {
        this.pending += chunk;
        const lines = this.pending.split("\n");
        this.pending = lines.pop() ?? "";
        for (const line of lines) this.line(line);
      });
      input.once("end", finish);
      input.once("close", finish);
      input.once("error", finish);
    });
  }

  /** Sends a request and settles with its result, or rejects with the agent's `AcpError`. */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.open) return Promise.reject(new ConnectionClosedError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (result: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Sends a notification. Not an error when the agent has gone: there is nobody to tell. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Ends the agent's stdin: the way an ACP agent is told there is nothing more, so it finishes and exits. */
  endInput(): void {
    this.output.end();
  }

  private write(message: object): void {
    if (this.output.destroyed || this.output.writableEnded) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private line(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(message)) return;
    // The agent numbers its own requests from 0, as the client does: a message with a method is the agent's request or
    // notification whatever its id, and only one without is a response.
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) this.handlers.notification?.(message.method, message.params);
      else void this.answer(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.waiting.get(message.id);
    if (!waiting) return;
    this.waiting.delete(message.id);
    if (isObject(message.error)) {
      const { code, message: text, data } = message.error;
      waiting.reject(new AcpError(typeof code === "number" ? code : INTERNAL_ERROR, typeof text === "string" ? text : "the agent reported an error", data));
    } else {
      waiting.resolve(message.result);
    }
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.request?.(method, params);
      if (result === undefined) throw new AcpError(METHOD_NOT_FOUND, `Method not found: ${method}`);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const known = error instanceof AcpError ? error : new AcpError(INTERNAL_ERROR, "Internal error");
      this.write({ jsonrpc: "2.0", id, error: { code: known.code, message: known.message } });
    }
  }
}
