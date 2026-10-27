import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENFORCEMENT_LEVELS,
  FAILURE_CLASSES,
  HANDOFF_REJECTION_REASONS,
  HandoffEvidenceSchema,
  PROTOCOL_VERSION,
  RECOVERY_POLICIES,
  UNKNOWN_REASONS,
} from "../src/protocol/index.ts";

// docs/a2a-mapping.md names closed lists of the protocol; a value added or renamed there must reach the document.
const doc = readFileSync(new URL("../docs/a2a-mapping.md", import.meta.url), "utf8");
const named = (value: string) => doc.includes(`\`${value}\``);

describe("docs/a2a-mapping.md", () => {
  it("names every value of the closed lists it maps", () => {
    const missing = [
      ...HANDOFF_REJECTION_REASONS,
      ...FAILURE_CLASSES,
      ...RECOVERY_POLICIES,
      ...UNKNOWN_REASONS,
      ...HandoffEvidenceSchema.options.map((option) => option.shape.kind.value),
      // the ledger's EvidenceItem kinds (`src/protocol/index.ts`) have no runtime list
      "diff_scope",
      "validator_error",
      // StepState
      "blocked",
      "ready",
      "in_progress",
      "verifying",
      "waiting_approval",
      "succeeded",
      "failed",
      "needs_recovery",
      "cancelled",
      "skipped",
    ].filter((value) => !named(value));
    expect(missing).toEqual([]);
  });

  it("says which enforcement level is enforcement", () => {
    expect(ENFORCEMENT_LEVELS).toContain("enforced_by_tool");
    expect(doc).toMatch(/Only `enforced_by_tool` is enforcement/);
  });

  it("gives an extension URI whose version is the protocol's major.minor", () => {
    const [major, minor] = PROTOCOL_VERSION.split(".");
    expect(doc).toContain(`https://github.com/Mohaned178/agent-handoff-protocol/extensions/ahp/${major}.${minor}`);
    expect(major).toBe("0");
  });

  it("states that nothing emits A2A and the protocol stays 0.x", () => {
    expect(doc).toMatch(/no code emits A2A JSON/);
    expect(doc).toMatch(/The protocol stays 0\.x/);
  });
});
