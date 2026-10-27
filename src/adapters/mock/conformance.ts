// The mock adapter as a conformance subject: every behaviour the suite asks for is a script. A pass here says the suite
// and the adapter contract hold together; it says nothing about any coding-agent tool, and is never evidence.

import type { ConformanceSubject } from "../../conformance/index.ts";
import { mock, mockAdapter, type MockAttemptScript } from "./index.ts";

const scripted = (script: MockAttemptScript) => mock({ attempts: [script] }).options;

export function mockSubject(): ConformanceSubject {
  return {
    adapter: mockAdapter,
    provokers: {
      completes: ({ probeFile, probeContent }) => ({
        options: scripted({ edits: [{ path: probeFile, content: probeContent }], outputFields: { summary: "conformance probe" } }),
      }),
      fails: () => ({ options: scripted({ exitCode: 1 }) }),
      login_problem: () => ({ options: scripted({ exitCode: 1, error: { kind: "config_auth", message: "not logged in (scripted)" } }) }),
      rate_limited: () => ({ options: scripted({ exitCode: 1, error: { kind: "transient", message: "rate limited (scripted)" } }) }),
      reports_model: () => ({ options: scripted({ reportedModel: "mock-reported-model" }), told: { model: "mock-reported-model" } }),
      no_model_report: () => ({ options: scripted({}) }),
      // Only two numbers: the rest are not reported, which the suite checks as null, never 0.
      reports_usage: () => ({ options: scripted({ usage: { inputTokens: 120, outputTokens: 30 } }), told: { usage: { inputTokens: 120, outputTokens: 30 } } }),
      no_usage_report: () => ({ options: scripted({}) }),
      hangs: () => ({ options: scripted({ hang: true }) }),
      resists_cancel: ({ pidFile }) => ({ options: scripted({ hang: true, spawnGrandchild: true, ignoreSignals: true, pidFile }) }),
      writes_when_read_only: ({ probeFile, probeContent }) => ({ options: scripted({ edits: [{ path: probeFile, content: probeContent }] }) }),
      writes_outside_scope: ({ outsideFile, probeContent }) => ({ options: scripted({ edits: [{ path: outsideFile, content: probeContent }] }) }),
      branches_in_shared_repo: ({ branch }) => ({ options: scripted({ git: [["branch", branch]] }) }),
      fetches_when_denied: ({ networkUrl }) => ({ options: scripted({ fetchUrl: networkUrl }) }),
    },
  };
}
