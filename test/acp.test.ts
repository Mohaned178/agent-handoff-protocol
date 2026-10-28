import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AcpConnection, AcpError, ConnectionClosedError } from "../src/adapters/acp/connection.ts";

/** An agent's two pipes, as the client sees them, and the lines the client has written to the agent so far. */
function pipes() {
  const fromAgent = new PassThrough();
  const toAgent = new PassThrough();
  toAgent.setEncoding("utf8");
  const written: string[] = [];
  let pending = "";
  toAgent.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    written.push(...lines);
  });
  const sent = () => written.map((line) => JSON.parse(line) as Record<string, unknown>);
  const say = (message: object) => fromAgent.write(`${JSON.stringify(message)}\n`);
  return { fromAgent, toAgent, sent, say };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("AcpConnection", () => {
  it("matches a response to its request by id, and rejects a JSON-RPC error with its code, message and data", async () => {
    const { fromAgent, toAgent, sent, say } = pipes();
    const connection = new AcpConnection(fromAgent, toAgent, {});

    const ok = connection.request("session/new", { cwd: "/w" });
    const bad = connection.request("session/set_config_option", { value: "x" });
    await tick();
    const [first, second] = sent();
    expect(first).toMatchObject({ jsonrpc: "2.0", method: "session/new", params: { cwd: "/w" } });
    // Answered out of order.
    say({ jsonrpc: "2.0", id: second!.id, error: { code: -32602, message: "model not found", data: { modelId: "x" } } });
    say({ jsonrpc: "2.0", id: first!.id, result: { sessionId: "ses_1" } });

    await expect(ok).resolves.toEqual({ sessionId: "ses_1" });
    await expect(bad).rejects.toMatchObject({ name: "AcpError", code: -32602, message: "model not found", data: { modelId: "x" } });
    await expect(bad).rejects.toBeInstanceOf(AcpError);
  });

  it("tells the agent's own requests from responses by their method, though the agent numbers its requests from 0 like the client", async () => {
    const { fromAgent, toAgent, sent, say } = pipes();
    const asked: unknown[] = [];
    const connection = new AcpConnection(fromAgent, toAgent, {
      request: async (method, params) => {
        asked.push([method, params]);
        return { outcome: { outcome: "selected", optionId: "once" } };
      },
    });

    const prompt = connection.request("session/prompt", {});
    await tick();
    const id = sent()[0]!.id;
    // The agent's request 1 has the id of the client's request 1.
    say({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: "s" } });
    await tick();
    await tick();

    expect(asked).toEqual([["session/request_permission", { sessionId: "s" }]]);
    expect(sent()[1]).toEqual({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: "once" } } });
    // The prompt is still waiting: that was not its response.
    let settled = false;
    prompt.then(() => (settled = true), () => (settled = true));
    await tick();
    expect(settled).toBe(false);
    say({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("answers a request it has no handler for, or whose handler throws an AcpError, with an error and never leaves the agent waiting", async () => {
    const { fromAgent, toAgent, sent, say } = pipes();
    new AcpConnection(fromAgent, toAgent, {
      request: async (method) => {
        if (method === "fs/read_text_file") throw new AcpError(-32602, "not allowed");
        if (method === "boom") throw new Error("internal detail");
        return undefined;
      },
    });

    say({ jsonrpc: "2.0", id: 0, method: "fs/write_text_file", params: {} });
    say({ jsonrpc: "2.0", id: 1, method: "fs/read_text_file", params: {} });
    say({ jsonrpc: "2.0", id: 2, method: "boom", params: {} });
    await tick();
    await tick();

    expect(sent()).toEqual([
      { jsonrpc: "2.0", id: 0, error: { code: -32601, message: "Method not found: fs/write_text_file" } },
      { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "not allowed" } },
      { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Internal error" } },
    ]);
  });

  it("hands notifications to the handler, and ignores lines that are not JSON-RPC", async () => {
    const { fromAgent, toAgent, say } = pipes();
    const seen: unknown[] = [];
    new AcpConnection(fromAgent, toAgent, { notification: (method, params) => seen.push([method, params]) });

    fromAgent.write("not json at all\n");
    fromAgent.write('{"unrelated": true}\n');
    say({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update" } } });
    await tick();

    expect(seen).toEqual([["session/update", { update: { sessionUpdate: "usage_update" } }]]);
  });

  it("reads messages that arrive in pieces, and a last message with no newline when the stream ends", async () => {
    const { fromAgent, toAgent, sent } = pipes();
    const seen: unknown[] = [];
    const connection = new AcpConnection(fromAgent, toAgent, { notification: (method) => seen.push(method) });
    const request = connection.request("initialize", {});
    await tick();
    const id = sent()[0]!.id;

    fromAgent.write('{"jsonrpc":"2.0","method":"a"');
    fromAgent.write('}\n{"jsonrpc":"2.0","method":"b"}\n');
    fromAgent.end(`{"jsonrpc":"2.0","id":${String(id)},"result":{"ok":true}}`);

    await expect(request).resolves.toEqual({ ok: true });
    expect(seen).toEqual(["a", "b"]);
  });

  it("rejects requests still waiting when the agent's output ends, and ones made after", async () => {
    const { fromAgent, toAgent } = pipes();
    const connection = new AcpConnection(fromAgent, toAgent, {});
    const waiting = connection.request("session/prompt", {});

    fromAgent.end();

    await expect(waiting).rejects.toBeInstanceOf(ConnectionClosedError);
    await expect(connection.request("session/prompt", {})).rejects.toBeInstanceOf(ConnectionClosedError);
    await connection.closed;
    // A notification to a gone agent is not an error.
    expect(() => connection.notify("session/cancel", {})).not.toThrow();
  });

  it("ends the agent's stdin on endInput(), which is how an ACP agent is told to finish", async () => {
    const { fromAgent, toAgent } = pipes();
    const connection = new AcpConnection(fromAgent, toAgent, {});
    const ended = new Promise<void>((resolve) => toAgent.once("end", resolve));

    connection.endInput();

    await ended;
  });
});
