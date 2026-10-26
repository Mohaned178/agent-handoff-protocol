import type { AdapterDeclaration } from "../adapters/index.ts";
import {
  BASELINE_REQUIREMENT,
  DEFAULT_CAPABILITY_REQUIREMENT,
  DEFAULT_NETWORK_REQUIREMENT,
  DEFAULT_NETWORK_STANCE,
  levelOn,
  meetsLevel,
  type AppliedCapabilities,
  type CapabilityRequest,
  type EnforcementLevel,
  type HandoffRevision,
  type NetworkRequest,
  type RejectionReason,
  type StepDefinition,
} from "../protocol/index.ts";

/** The operating system the run is on, as Node names it. Tests pass another to see how an adapter's levels differ by system. */
export const currentPlatform = (): string => process.platform;

/**
 * The capability requests and network stance a step's handoff carries: what its definition lists, with the default
 * requirement filled in, and the baseline `no_external_actions` of every agent step (ADR 0003) unless it is listed. The
 * baseline requires nothing, so an adapter that cannot ask is reported, never the reason a handoff is rejected.
 */
export function requestsOf(step: Pick<StepDefinition, "capabilities" | "network">): { capabilities: CapabilityRequest[]; network: NetworkRequest } {
  const capabilities: CapabilityRequest[] = (step.capabilities ?? []).map((request) => ({
    ...request,
    ...(request.kind === "write_scope" ? { paths: [...request.paths] } : {}),
    require: request.require ?? DEFAULT_CAPABILITY_REQUIREMENT,
  }));
  if (!capabilities.some((request) => request.kind === "no_external_actions")) {
    capabilities.push({ kind: "no_external_actions", require: BASELINE_REQUIREMENT });
  }
  return {
    capabilities,
    network: { stance: step.network?.stance ?? DEFAULT_NETWORK_STANCE, require: step.network?.require ?? DEFAULT_NETWORK_REQUIREMENT },
  };
}

const describeReach = (what: string, level: EnforcementLevel) => (level === "none" ? `cannot apply ${what}` : `applies ${what} at most at "${level}"`);

/**
 * What the recipient's adapter is asked to apply for a handoff, with the level its declaration reaches for each request
 * on `platform`, and a rejection reason for every request it does not reach the required level for. The levels are the
 * declared ones: nothing here asks the tool.
 */
export function resolveCapabilities(
  handoff: Pick<HandoffRevision, "capabilities" | "network">,
  declaration: AdapterDeclaration,
  platform: string,
): { applied: AppliedCapabilities; shortfalls: RejectionReason[] } {
  const shortfalls: RejectionReason[] = [];
  const shortfall = (pointer: string, what: string, level: EnforcementLevel, required: EnforcementLevel) => {
    shortfalls.push({
      code: "capability_unsatisfiable",
      pointer,
      message: `adapter "${declaration.name}" ${describeReach(what, level)} on ${platform}, and the handoff requires "${required}"`,
    });
  };
  const capabilities = handoff.capabilities.map((request, index) => {
    const level = levelOn(declaration.capabilities[request.kind], platform);
    if (!meetsLevel(level, request.require)) shortfall(`/capabilities/${index}`, request.kind, level, request.require);
    return { ...request, level };
  });
  const level = levelOn(declaration.network[handoff.network.stance], platform);
  if (!meetsLevel(level, handoff.network.require)) shortfall("/network", `the network stance "${handoff.network.stance}"`, level, handoff.network.require);
  return { applied: { platform, capabilities, network: { ...handoff.network, level } }, shortfalls };
}
