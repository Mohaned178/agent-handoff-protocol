import { afterEach, describe, expect, it } from "vitest";
import { runWorkflow } from "../src/index.ts";
import type { EvidenceItem } from "../src/index.ts";
import { ahp } from "./helpers/cli.ts";
import { addBareRemote, remoteBranch } from "./helpers/external.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { hello, implementOf, retryWorkflow } from "./helpers/retry.ts";

afterEach(removeTempRepos);

const detectedIn = (evidence: readonly EvidenceItem[]) => evidence.find((item) => item.kind === "forbidden_external_action_detected");

function fixture() {
  const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
  return { repo, remote: addBareRemote(repo) };
}

describe("a coding agent that performs an external action itself", () => {
  it("fails verification with forbidden_external_action_detected when it pushes, and the command is not run", async () => {
    const { repo, remote } = fixture();
    const pushing = { ...hello, git: [["push", "--quiet", "origin", "HEAD:refs/heads/sneaky"]] };

    const { state } = await runWorkflow(retryWorkflow([pushing], { retry: { budget: 0 } }), { repo });

    const implement = implementOf(state);
    expect([state.state, implement.failureClass]).toEqual(["failed", "verification_failed"]);
    const { verification } = implement.attempts[0]!;
    expect(verification!.state).toBe("fail");
    expect(detectedIn(verification!.evidence)).toEqual({
      kind: "forbidden_external_action_detected",
      changed: [{ name: "refs/remotes/origin/sneaky", before: null, after: expect.stringMatching(/^[0-9a-f]{40}$/) }],
      truncated: false,
    });
    expect(verification!.evidence.some((item) => item.kind === "test_output")).toBe(false);
    // AHP saw it, and cannot take it back.
    expect(remoteBranch(remote, "sneaky")).not.toBeNull();
  });

  it("detects branches and tags it made, and tells the retry what it changed", async () => {
    const { repo } = fixture();
    const branching = { ...hello, git: [["branch", "mine"], ["tag", "v1"]] };

    const { state } = await runWorkflow(retryWorkflow([branching, hello]), { repo });

    expect(state.state).toBe("succeeded");
    const implement = implementOf(state);
    expect(implement.attempts.map((a) => a.verification!.state)).toEqual(["fail", "pass"]);
    const changed = [
      { name: "refs/heads/mine", before: null, after: expect.any(String) },
      { name: "refs/tags/v1", before: null, after: expect.any(String) },
    ];
    expect(detectedIn(implement.attempts[0]!.verification!.evidence)).toMatchObject({ changed });
    expect(implement.handoffs[1]!.handoff.evidence).toEqual([{ kind: "forbidden_external_action_detected", changed, truncated: false }]);
    // The second attempt changed no shared ref: nothing is detected again for the refs the first one left.
    expect(detectedIn(implement.attempts[1]!.verification!.evidence)).toBeUndefined();
  });

  it("is reported for an agent that pushed and then failed, which is never verified", async () => {
    const { repo } = fixture();
    const pushingThenFailing = { git: [["push", "--quiet", "origin", "HEAD:refs/heads/sneaky"]], exitCode: 3 };
    const { runId, state } = await runWorkflow(retryWorkflow([pushingThenFailing], { retry: { budget: 0 } }), { repo });
    const attempt = implementOf(state).attempts[0]!;
    expect([attempt.failureClass, attempt.verification]).toEqual(["agent_error", null]);

    const inspect = ahp(["inspect", runId], repo).stdout;

    expect(inspect).toContain(`external actions by coding agents: detected in attempt ${attempt.id} of step implement`);
    expect(inspect).toContain("    verification: not run\n    forbidden external action detected: 1 shared ref changed while the agent ran");
    expect(inspect).toMatch(/\| refs\/remotes\/origin\/sneaky: \(none\) -> [0-9a-f]{12}/);
  });

  it("is reported by ahp inspect, which says that the absence of this evidence is not proof", async () => {
    const { repo } = fixture();
    const clean = await runWorkflow(retryWorkflow([hello]), { repo });
    const caught = await runWorkflow(retryWorkflow([{ ...hello, git: [["branch", "mine"]] }], { retry: { budget: 0 } }), { repo });

    const quiet = ahp(["inspect", clean.runId], repo).stdout;
    const loud = ahp(["inspect", caught.runId], repo).stdout;

    const notProof = "the absence of this evidence is not proof that no agent performed an external action";
    expect(quiet).toContain("external actions by coding agents: none detected; detection is partial");
    expect(quiet).toContain(notProof);
    const attemptId = implementOf(caught.state).attempts[0]!.id;
    expect(loud).toContain(`external actions by coding agents: detected in attempt ${attemptId} of step implement; detection is partial`);
    expect(loud).toContain("evidence: forbidden external action detected: 1 shared ref changed while the agent ran");
    expect(loud).toMatch(/\| refs\/heads\/mine: \(none\) -> [0-9a-f]{12}/);
    expect(loud).toContain("AHP cannot tell who changed them");
  });
});
