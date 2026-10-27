// The prompt an adapter gives its coding agent on stdin for an attempt: the handoff the recipient accepted, as plain text.
// It goes on stdin, never in the arguments, so no character of it is read by a shell or the Windows command line.

import type { CapabilityRequest, HandoffEvidence, HandoffRevision, OutputFieldValue } from "../protocol/index.ts";

const text = (value: OutputFieldValue): string => (typeof value === "string" ? value : value.map((item) => `- ${item}`).join("\n"));

function evidenceText(item: HandoffEvidence): string {
  switch (item.kind) {
    case "test_output":
      return item.output === null
        ? `The check \`${item.command}\` failed (exit code ${item.exitCode ?? "none"}); its output is withheld.`
        : `The check \`${item.command}\` failed (exit code ${item.exitCode ?? "none"}${item.truncated ? ", the end of its output" : ""}):\n${item.output}`;
    case "required_output_fields":
      return `You did not report these required fields: ${item.missing.join(", ")}.`;
    case "review_findings":
      return `The review step "${item.reviewStepId}" asked for changes:\n${item.findings.map((finding) => `- ${finding}`).join("\n")}`;
    case "approval_rejected":
      return `A person rejected the result at the approval gate "${item.gateStepId}": ${item.reason}`;
    case "review_verdict":
      return `Your verdict ${JSON.stringify(item.reported)} was not one of: ${item.allowed.join(", ")}.`;
    case "protected_paths":
      return `You changed paths this step must not change:\n${item.violations.map((violation) => `- ${violation.path} (${violation.change})`).join("\n")}${item.truncated ? "\n- and more" : ""}`;
    case "forbidden_external_action_detected":
      return `You changed shared refs, which only AHP may do:\n${item.changed.map((ref) => `- ${ref.name}`).join("\n")}${item.truncated ? "\n- and more" : ""}`;
  }
}

function limitText(request: CapabilityRequest): string {
  switch (request.kind) {
    case "read_only":
      return "Change no file in this workspace: this step only reads.";
    case "write_scope":
      return `Change files only under: ${request.paths.join(", ")}.`;
    case "no_external_actions":
      return "Do not push, open or merge a pull request, or create, move or delete a branch or tag. AHP does that itself after the result is verified.";
  }
}

/** What to tell the agent for `handoff`, with `reportFields` to report in addition to the ones the step requires. */
export function promptFor(handoff: HandoffRevision, reportFields: readonly string[], extraInstructions: string | undefined): string {
  const sections: string[] = [];
  sections.push(`# Task\n\n${handoff.contract.instructions ?? "No instructions were given for this step."}`);
  if (extraInstructions) sections.push(extraInstructions);

  const context = Object.entries(handoff.context.fields);
  if (context.length > 0) {
    sections.push(`## What the earlier steps decided and learned\n\n${context.map(([name, value]) => `### ${name}\n${text(value)}`).join("\n\n")}`);
  }
  if (handoff.artifacts.length > 0) {
    sections.push(`## Files handed on to you\n\n${handoff.artifacts.map((artifact) => `- ${artifact.path}`).join("\n")}`);
  }
  if (handoff.evidence.length > 0) {
    sections.push(`## Why your last attempt at this step was not accepted\n\n${handoff.evidence.map(evidenceText).join("\n\n")}`);
  }
  // Asked of the agent in words: how far an adapter applies these through its tool is its own declaration, and words are not enforcement.
  const limits = handoff.capabilities.map(limitText);
  if (limits.length > 0) sections.push(`## Limits on this step\n\n${limits.map((limit) => `- ${limit}`).join("\n")}`);

  const fields = [...new Set([...handoff.contract.acceptance.requiredOutputFields, ...reportFields])];
  if (fields.length > 0) {
    sections.push(
      `## Report\n\nWhen you are done, report these fields through the structured output: ${fields.join(", ")}. ` +
        "Each is text, or a list of text items. Report what you actually did and found.",
    );
  }
  return `${sections.join("\n\n")}\n`;
}
