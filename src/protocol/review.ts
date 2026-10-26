// Review steps: what a reviewing coding agent reports, and how the report is read.

import { isPresentOutputField, REVIEW_VERDICTS, type OutputFieldValue, type ReviewVerdict } from "./handoff.ts";

/** The output fields every review step requires, whatever else its definition lists. */
export const REVIEW_OUTPUT_FIELDS = ["verdict", "findings"] as const;

/**
 * The verdict a review reported: its `verdict` field, with surrounding whitespace ignored, when that is one of the
 * two; null when the field is missing or says anything else.
 */
export function reviewVerdictOf(reported: Readonly<Record<string, OutputFieldValue>>): ReviewVerdict | null {
  const verdict = reported.verdict;
  if (typeof verdict !== "string") return null;
  return REVIEW_VERDICTS.find((known) => known === verdict.trim()) ?? null;
}

/** The findings a review reported: the non-blank items of its `findings` field, one string for a field that is text. */
export function reviewFindingsOf(reported: Readonly<Record<string, OutputFieldValue>>): string[] {
  const findings = reported.findings;
  const items = typeof findings === "string" ? [findings] : Array.isArray(findings) ? findings : [];
  return items.filter((item) => isPresentOutputField(item));
}

/**
 * The output fields a step must report: the ones its verification lists, and for a review step `verdict` and
 * `findings` too. A passing attempt's fields are what the next step's handoff carries as context.
 */
export function requiredOutputFieldsOf(step: {
  verification: { requiredOutputFields?: readonly string[] };
  review?: unknown;
}): string[] {
  const declared = step.verification.requiredOutputFields ?? [];
  if (step.review === undefined) return [...declared];
  return [...declared, ...REVIEW_OUTPUT_FIELDS.filter((field) => !declared.includes(field))];
}
