import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow, mock, runWorkflow } from "../src/index.ts";
import type { EvidenceItem, MockAttemptScript, RunView, VerificationDefinition } from "../src/index.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_OK } from "./helpers/repo.ts";

afterEach(removeTempRepos);

/** A one-step workflow whose mock agent runs `script` and whose verification is `verification`. */
function stepWorkflow(script: MockAttemptScript, verification: VerificationDefinition) {
  return defineWorkflow({
    name: "scoped",
    steps: [{ id: "implement", agent: mock({ attempts: [script] }), verification }],
  });
}

function verificationOf(state: RunView) {
  const verification = state.steps[0]?.attempts[0]?.verification;
  if (!verification) throw new Error("the attempt was not verified");
  return verification;
}

function evidenceOfKind<K extends EvidenceItem["kind"]>(state: RunView, kind: K): Extract<EvidenceItem, { kind: K }>[] {
  return verificationOf(state).evidence.filter((item): item is Extract<EvidenceItem, { kind: K }> => item.kind === kind);
}

describe("protected paths", () => {
  it("fails verification with a protected-path evidence item when the attempt changes a protected file", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK, "runner.config.mjs": "export default {};\n" });

    const { state } = await runWorkflow(
      stepWorkflow(
        { edits: [{ path: "runner.config.mjs", content: "export default { skip: true };\n" }] },
        { command: "node verify.mjs", protectedPaths: ["runner.config.mjs"] },
      ),
      { repo },
    );

    expect(state.state).toBe("failed");
    expect(state.steps[0]).toMatchObject({ state: "failed", failureClass: "verification_failed" });
    expect(verificationOf(state).state).toBe("fail");
    expect(evidenceOfKind(state, "protected_paths")).toEqual([
      expect.objectContaining({
        protected: ["runner.config.mjs"],
        violations: [{ path: "runner.config.mjs", change: "modified" }],
      }),
    ]);
  });

  it("does not run the verification command once a protected path has changed", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK, "runner.config.mjs": "export default {};\n" });

    const { state } = await runWorkflow(
      stepWorkflow(
        { edits: [{ path: "runner.config.mjs", content: "changed\n" }] },
        { command: "node verify.mjs", protectedPaths: ["runner.config.mjs"] },
      ),
      { repo },
    );

    expect(evidenceOfKind(state, "test_output")).toEqual([]);
    expect(verificationOf(state).worktree).toBeNull();
  });

  it("fails when the attempt deletes a protected file", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK, "scripts/test.mjs": "// the test script\n" });

    const { state } = await runWorkflow(
      stepWorkflow({ deletes: ["scripts/test.mjs"] }, { command: "node verify.mjs", protectedPaths: ["scripts/test.mjs"] }),
      { repo },
    );

    expect(verificationOf(state).state).toBe("fail");
    expect(evidenceOfKind(state, "protected_paths")[0]?.violations).toEqual([{ path: "scripts/test.mjs", change: "deleted" }]);
  });

  it("protects everything under a protected directory, including files the attempt adds", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK, ".github/workflows/ci.yml": "name: ci\n" });

    const { state } = await runWorkflow(
      stepWorkflow(
        { edits: [{ path: ".github/workflows/extra.yml", content: "name: extra\n" }] },
        { command: "node verify.mjs", protectedPaths: [".github"] },
      ),
      { repo },
    );

    expect(verificationOf(state).state).toBe("fail");
    expect(evidenceOfKind(state, "protected_paths")[0]?.violations).toEqual([
      { path: ".github/workflows/extra.yml", change: "added" },
    ]);
  });

  it("catches a change the agent committed in its workspace", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK, "runner.config.mjs": "export default {};\n" });

    const { state } = await runWorkflow(
      stepWorkflow(
        { edits: [{ path: "runner.config.mjs", content: "changed\n" }], commit: true },
        { command: "node verify.mjs", protectedPaths: ["runner.config.mjs"] },
      ),
      { repo },
    );

    expect(verificationOf(state).state).toBe("fail");
    expect(evidenceOfKind(state, "protected_paths")[0]?.violations).toEqual([
      { path: "runner.config.mjs", change: "modified" },
    ]);
  });

  it("passes when the attempt changes only unprotected files, and records what it changed", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK, "runner.config.mjs": "export default {};\n" });

    const { state } = await runWorkflow(
      stepWorkflow(
        { edits: [{ path: "src/feature.mjs", content: "export const feature = 1;\n" }] },
        { command: "node verify.mjs", protectedPaths: ["runner.config.mjs"] },
      ),
      { repo },
    );

    expect(state.state).toBe("succeeded");
    expect(evidenceOfKind(state, "protected_paths")[0]).toMatchObject({ violations: [], truncated: false });
    expect(evidenceOfKind(state, "diff_scope")).toEqual([
      { kind: "diff_scope", changed: [{ path: "src/feature.mjs", change: "added" }], truncated: false },
    ]);
  });

  it("treats a change that replaces a directory holding a protected path as a violation", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK, "tests/keep.txt": "x\n" });

    // `tests` becomes a file: whatever was protected beneath it is gone, though no protected path is in the diff.
    const { state } = await runWorkflow(
      stepWorkflow(
        { deletes: ["tests"], edits: [{ path: "tests", content: "now a file\n" }] },
        { command: "node verify.mjs", protectedPaths: ["tests/hidden/check.mjs"] },
      ),
      { repo },
    );

    expect(verificationOf(state).state).toBe("fail");
    expect(evidenceOfKind(state, "protected_paths")[0]?.violations.map((v) => v.path)).toContain("tests");
  });

  it("compares protected paths without regard to case", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK, "Runner.Config.mjs": "x\n" });

    const { state } = await runWorkflow(
      stepWorkflow(
        { edits: [{ path: "Runner.Config.mjs", content: "y\n" }] },
        { command: "node verify.mjs", protectedPaths: ["runner.config.mjs"] },
      ),
      { repo },
    );

    expect(verificationOf(state).state).toBe("fail");
  });
});

const HIDDEN_GREETING_CHECK = `
import { readFileSync } from "node:fs";
const ok = readFileSync("greeting.txt", "utf8").trim() === "hello";
console.log(ok ? "hidden greeting check ok" : "hidden greeting check failed");
process.exit(ok ? 0 : 1);
`;
const hiddenGreeting = { path: "hidden/greeting.check.mjs", content: HIDDEN_GREETING_CHECK };

describe("hidden tests", () => {
  const verification = { command: "node hidden/greeting.check.mjs", hiddenTests: [hiddenGreeting] };

  it("run in the verification worktree and decide the verdict", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });

    const passing = await runWorkflow(stepWorkflow({ edits: [{ path: "greeting.txt", content: "hello\n" }] }, verification), { repo });
    const failing = await runWorkflow(stepWorkflow({ edits: [{ path: "greeting.txt", content: "bye\n" }] }, verification), { repo });

    expect(passing.state.state).toBe("succeeded");
    expect(evidenceOfKind(passing.state, "test_output")[0]?.output).toContain("hidden greeting check ok");
    expect(failing.state.state).toBe("failed");
    expect(failing.state.steps[0]?.failureClass).toBe("verification_failed");
    expect(evidenceOfKind(failing.state, "test_output")[0]?.output).toContain("hidden greeting check failed");
  });

  it("never appear in the agent's workspace, the snapshot or the handoff", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });

    const { state } = await runWorkflow(
      stepWorkflow({ edits: [{ path: "greeting.txt", content: "hello\n" }] }, verification),
      { repo },
    );

    const attempt = state.steps[0]!.attempts[0]!;
    expect(attempt.verification?.state).toBe("pass");
    expect(existsSync(join(attempt.workspace, "hidden"))).toBe(false);
    expect(git(repo, "ls-tree", "-r", "--name-only", attempt.snapshot!.commit)).not.toContain("hidden");
    const handoff = JSON.stringify(state.steps[0]!.handoffs);
    // The handoff shows the agent the verification command, which names the file, but not the file or the declaration.
    expect(handoff).not.toContain("hidden greeting check");
    expect(handoff).not.toContain("hiddenTests");
    // The verification worktree is gone, and the repository's checkout never had them.
    expect(existsSync(join(repo, "hidden"))).toBe(false);
  });

  it("are not affected by tests the agent writes: its failing test does not fail the step, its passing test does not save it", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });
    const agentTest = (exit: number) => ({ path: "agent.check.mjs", content: `process.exit(${exit});\n` });

    const failingOwnTest = await runWorkflow(
      stepWorkflow({ edits: [{ path: "greeting.txt", content: "hello\n" }, agentTest(1)] }, verification),
      { repo },
    );
    const passingOwnTest = await runWorkflow(
      stepWorkflow({ edits: [{ path: "greeting.txt", content: "bye\n" }, agentTest(0)] }, verification),
      { repo },
    );

    expect(failingOwnTest.state.state).toBe("succeeded");
    expect(passingOwnTest.state.state).toBe("failed");
    expect(verificationOf(passingOwnTest.state).state).toBe("fail");
  });

  it("are protected paths: an attempt that writes to one fails verification", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });

    const { state } = await runWorkflow(
      stepWorkflow(
        {
          edits: [
            { path: "greeting.txt", content: "bye\n" },
            { path: "hidden/greeting.check.mjs", content: "process.exit(0);\n" },
          ],
        },
        verification,
      ),
      { repo },
    );

    expect(verificationOf(state).state).toBe("fail");
    expect(evidenceOfKind(state, "protected_paths")[0]).toMatchObject({
      protected: ["hidden/greeting.check.mjs"],
      violations: [{ path: "hidden/greeting.check.mjs", change: "added" }],
    });
    expect(evidenceOfKind(state, "test_output")).toEqual([]);
  });
});

describe("a validator that breaks", () => {
  const edit = { edits: [{ path: "greeting.txt", content: "hello\n" }] };

  it("is inconclusive, not fail, when the command exits with the shell's cannot-run code", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });

    const { state } = await runWorkflow(stepWorkflow(edit, { command: 'node -e "process.exit(127)"' }), { repo });

    expect(verificationOf(state).state).toBe("inconclusive");
    expect(state.steps[0]).toMatchObject({ state: "failed", failureClass: "inconclusive" });
    expect(state.state).toBe("failed");
    expect(evidenceOfKind(state, "test_output")[0]).toMatchObject({ exitCode: 127 });
  });

  it("is a plain failure when the tests fail with any other non-zero exit code", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });

    const { state } = await runWorkflow(stepWorkflow(edit, { command: 'node -e "process.exit(2)"' }), { repo });

    expect(verificationOf(state).state).toBe("fail");
    expect(state.steps[0]?.failureClass).toBe("verification_failed");
  });

  it.skipIf(process.platform === "win32")("is inconclusive when the command is killed by a signal", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });

    const { state } = await runWorkflow(stepWorkflow(edit, { command: "kill -9 $$" }), { repo });

    expect(verificationOf(state).state).toBe("inconclusive");
    expect(evidenceOfKind(state, "test_output")[0]).toMatchObject({ exitCode: null, signal: "SIGKILL" });
  });

  it("is inconclusive when AHP cannot set the verification up, and leaves no verification worktree behind", async () => {
    // `tests` is a file in the repository, so a hidden test at tests/check.mjs cannot be placed on any OS.
    const repo = createTempRepo({ tests: "not a directory\n" });

    const { state } = await runWorkflow(
      stepWorkflow(edit, {
        command: "node tests/check.mjs",
        hiddenTests: [{ path: "tests/check.mjs", content: "process.exit(0);\n" }],
      }),
      { repo },
    );

    expect(verificationOf(state).state).toBe("inconclusive");
    expect(state.steps[0]?.failureClass).toBe("inconclusive");
    expect(evidenceOfKind(state, "validator_error")).toEqual([
      expect.objectContaining({ stage: "hidden_tests", message: expect.stringContaining("tests/check.mjs") }),
    ]);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
  });

  it("does not hide a failure another check found: missing output fields still fail the verdict", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });

    const { state } = await runWorkflow(
      stepWorkflow(edit, { command: 'node -e "process.exit(127)"', requiredOutputFields: ["summary"] }),
      { repo },
    );

    expect(verificationOf(state).state).toBe("fail");
    expect(state.steps[0]?.failureClass).toBe("verification_failed");
  });
});

describe("dependency installation", () => {
  const edit = { edits: [{ path: "greeting.txt", content: "hello\n" }] };
  const writeMarker = `node -e "require('node:fs').writeFileSync('installed.txt', 'fresh')"`;
  const markerPresent = `node -e "process.exit(require('node:fs').existsSync('installed.txt') ? 0 : 1)"`;

  it("runs the install command in the verification worktree before the verification command", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });

    const { state } = await runWorkflow(stepWorkflow(edit, { install: writeMarker, command: markerPresent }), { repo });

    const attempt = state.steps[0]!.attempts[0]!;
    expect(attempt.verification?.state).toBe("pass");
    // What install produced belongs to the verification worktree alone.
    expect(existsSync(join(attempt.workspace, "installed.txt"))).toBe(false);
    expect(git(repo, "ls-tree", "-r", "--name-only", attempt.snapshot!.commit)).not.toContain("installed.txt");
  });

  it("is inconclusive, not fail, when the install fails: the validator never ran", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });

    const { state } = await runWorkflow(
      stepWorkflow(edit, { install: 'node -e "console.error(\'registry unreachable\'); process.exit(1)"', command: markerPresent }),
      { repo },
    );

    expect(verificationOf(state).state).toBe("inconclusive");
    expect(state.steps[0]?.failureClass).toBe("inconclusive");
    expect(evidenceOfKind(state, "validator_error")).toEqual([
      expect.objectContaining({ stage: "install", message: expect.stringContaining("registry unreachable") }),
    ]);
    expect(evidenceOfKind(state, "test_output")).toEqual([]);
  });
});

describe("workflow definition", () => {
  it("rejects an install command or hidden tests without a verification command", () => {
    const attempt = () =>
      stepWorkflow({}, { requiredOutputFields: ["summary"], install: "npm ci", hiddenTests: [hiddenGreeting] });

    expect(attempt).toThrow(/`verification.install` needs a `verification.command`/);
    expect(attempt).toThrow(/`verification.hiddenTests` need a `verification.command`/);
  });

  it("rejects invalid protected paths", () => {
    const attempt = () =>
      stepWorkflow({}, { command: "node verify.mjs", protectedPaths: ["../outside", "a/b", "a/b"] });

    expect(attempt).toThrow(/protected path "..\/outside" must be relative to the repository root/);
    expect(attempt).toThrow(/protected path "a\/b" is listed twice/);
  });
});
