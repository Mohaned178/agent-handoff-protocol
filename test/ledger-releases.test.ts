import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyEvent, readLedger, replay } from "../src/ledger/index.ts";
import { isNewerProtocol, PROTOCOL_VERSION, type LedgerEvent } from "../src/protocol/index.ts";

// Ledgers recorded by each released AHP, kept so that a later AHP is checked against them (ticket 09). Add a directory
// per release, from a run of `ahp demo` approved to its end; never edit one: its hash chain is part of what is checked.
const fixtures = fileURLToPath(new URL("fixtures/ledgers/", import.meta.url));

/** What a person reads of a finished run: its state, and each step's kind, state and attempts. */
const EXPECTED: Record<string, unknown> = {
  "0.1.0/demo-approved.jsonl": {
    protocolVersion: "0.1.0",
    state: "succeeded",
    steps: [
      { id: "plan", kind: "agent", state: "succeeded", attempts: ["exited"] },
      { id: "implement", kind: "agent", state: "succeeded", attempts: ["exited", "exited"] },
      { id: "review", kind: "review", state: "succeeded", attempts: ["exited", "exited"] },
      { id: "approve", kind: "approval_gate", state: "succeeded", attempts: [] },
      { id: "publish", kind: "external_action", state: "succeeded", attempts: [] },
    ],
  },
};

const recorded = readdirSync(fixtures).flatMap((release) => readdirSync(join(fixtures, release)).map((file) => `${release}/${file}`));

describe("ledgers recorded by released versions", () => {
  it("are all listed with what they must replay to", () => {
    expect(recorded.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(recorded)("%s still has an intact chain and replays to the same run", async (name) => {
    const read = await readLedger(join(fixtures, name));
    expect(read.corruption ?? null).toBeNull();
    const state = replay(read.events as LedgerEvent[]);
    expect({
      protocolVersion: state.protocolVersion,
      state: state.state,
      steps: state.steps.map((step) => ({ id: step.id, kind: step.kind, state: step.state, attempts: step.attempts.map((attempt) => attempt.state) })),
    }).toEqual(EXPECTED[name]);
  });
});

describe("a ledger recorded under a newer protocol", () => {
  it("is refused with both versions named, never misread", () => {
    const created = { type: "run_created", seq: 1, runId: "run_future", protocolVersion: "0.2.0" } as unknown as LedgerEvent;
    expect(() => applyEvent(undefined, created)).toThrow(`run run_future was recorded under AHP protocol 0.2.0, which this AHP (protocol ${PROTOCOL_VERSION}) cannot read: install a newer AHP`);
  });

  it("is newer at a higher major or, under 1.0, a higher minor; a newer patch and any older version are read", () => {
    expect(isNewerProtocol("1.0.0", "0.1.0")).toBe(true);
    expect(isNewerProtocol("0.2.0", "0.1.0")).toBe(true);
    expect(isNewerProtocol("0.1.9", "0.1.0")).toBe(false);
    expect(isNewerProtocol("0.0.3", "0.1.0")).toBe(false);
    expect(isNewerProtocol("1.4.0", "1.2.0")).toBe(false);
    expect(isNewerProtocol("2.0.0", "1.2.0")).toBe(true);
    expect(isNewerProtocol("not a version", "0.1.0")).toBe(true);
  });
});
