// The run this process is running for the app: started with `runWorkflow`, one at a time, cancelled through the run's
// `signal` (so `run_cancel_requested` is recorded first and the cancel only after every process of the agent is seen gone).
// The run's state is the ledger's, which the run screen follows; this keeps only what the ledger cannot say yet: that a run
// is starting (no ID until its first event is written), that this process is cancelling it, and why `runWorkflow` threw.

import type { Clock } from "../runtime/clock.ts";
import type { RunState, RunView, WorkflowDefinition } from "../protocol/index.ts";
import { approveStep, recoverAttempt, rejectStep, resumeRun, runWorkflow } from "../sdk/index.ts";
import type { DecisionRequest } from "../commands/decision.ts";

export interface DecideSpec {
  repo: string;
  runId: string;
  /** The workflow's name. */
  name: string;
  mock: boolean;
  request: DecisionRequest;
}

export interface RunSpec {
  workflow: WorkflowDefinition;
  /** Any directory inside the repository to run against. */
  repo: string;
  /** The scripted mock plays the steps: said wherever the run is shown. */
  mock: boolean;
}

export interface ActiveRun {
  /** The workflow's name. */
  name: string;
  mock: boolean;
  /** Null until the run's first event is in its ledger. */
  runId: string | null;
  /** `starting` until the first event, `running` after, `cancelling` once a cancel was asked, `ended` when `runWorkflow` returned or threw. */
  phase: "starting" | "running" | "cancelling" | "ended";
  /** True when a person's decision took the run on (`decide`); false for a run started here. */
  decided: boolean;
  /** How the run ended or stopped for a person (`waiting_approval`, `needs_recovery`, `succeeded`...), once `ended`. */
  outcome: RunState | null;
  /** Why `runWorkflow` threw, once `ended` by a throw; one line. */
  error: string | null;
}

export interface TaskRunnerOptions {
  /** Waits out retry backoffs and stamps events; default the system clock. Tests give one that never waits. */
  clock?: Clock;
  cancelGraceMs?: number;
  /** Default `runWorkflow`; tests give a slower or failing one. */
  run?: typeof runWorkflow;
}

export class TaskRunner {
  private readonly options: TaskRunnerOptions;
  private active: ActiveRun | null = null;
  private controller: AbortController | null = null;
  private finished: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(options: TaskRunnerOptions = {}) {
    this.options = options;
  }

  /** The run started here last, going or ended; a new object whenever anything about it changed. */
  current(): ActiveRun | null {
    return this.active;
  }

  /** Whether a run started here has not ended. */
  going(): boolean {
    return this.active !== null && this.active.phase !== "ended";
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Resolves once the run in hand has ended (at once when none is going). */
  settled(): Promise<void> {
    return this.finished;
  }

  private set(next: ActiveRun): void {
    this.active = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Starts the run and returns at once. Throws if one started here is still going. */
  start({ workflow, repo, mock }: RunSpec): void {
    if (this.going()) throw new Error("a run is already going in this window");
    const controller = new AbortController();
    this.controller = controller;
    const name = workflow.name;
    this.set({ name, mock, runId: null, phase: "starting", decided: false, outcome: null, error: null });
    const run = this.options.run ?? runWorkflow;
    this.finished = run(workflow, {
      repo,
      signal: controller.signal,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.cancelGraceMs === undefined ? {} : { cancelGraceMs: this.options.cancelGraceMs }),
      onEvent: (_event, state) => {
        const now = this.active;
        if (now && now.runId === null) this.set({ ...now, runId: state.runId, phase: controller.signal.aborted ? "cancelling" : "running" });
      },
    }).then(
      (result) => {
        this.set({ ...this.active!, runId: result.runId, phase: "ended", outcome: result.state.state });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.set({ ...this.active!, phase: "ended", error: message.split("\n")[0]! });
      },
    );
  }

  /**
   * Takes a run that waits for a person on from where it stopped: approves or rejects its gate, decides an unknown
   * attempt, or resumes a run whose process stopped. It goes on in this process under the same `signal` as a run started
   * here, until it ends or stops for a person again; returns at once. A refusal (decided elsewhere, a lock held by a
   * live process) ends it with `error`, one line, and writes nothing. Throws if a run started here is still going.
   */
  decide({ repo, runId, name, mock, request }: DecideSpec): void {
    if (this.going()) throw new Error("a run is already going in this window");
    const controller = new AbortController();
    this.controller = controller;
    this.set({ name, mock, runId, phase: "running", decided: true, outcome: null, error: null });
    const shared = {
      repo,
      signal: controller.signal,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.cancelGraceMs === undefined ? {} : { cancelGraceMs: this.options.cancelGraceMs }),
    };
    const go = async (): Promise<{ state: RunView; note: string | null }> => {
      switch (request.type) {
        case "approve":
          return { ...(await approveStep({ ...shared, runId, stepId: request.stepId })), note: null };
        case "reject":
          return { ...(await rejectStep({ ...shared, runId, stepId: request.stepId, reason: request.reason })), note: null };
        case "adopt":
        case "abort":
          return { ...(await recoverAttempt({ ...shared, attemptId: request.attemptId, policy: request.type })), note: null };
        case "resume": {
          const result = await resumeRun({ ...shared, runId });
          return { state: result.state, note: result.resumed ? null : `nothing to resume: the run is ${result.state.state}` };
        }
      }
    };
    this.finished = go().then(
      ({ state, note }) => {
        this.set({ ...this.active!, phase: "ended", outcome: state.state, error: note });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.set({ ...this.active!, phase: "ended", error: message.split("\n")[0]! });
      },
    );
  }

  /** Asks the run to cancel: through its signal, so the cancel is recorded in its ledger. */
  cancel(): void {
    if (!this.going() || this.controller === null || this.controller.signal.aborted) return;
    this.controller.abort();
    this.set({ ...this.active!, phase: "cancelling" });
  }
}
