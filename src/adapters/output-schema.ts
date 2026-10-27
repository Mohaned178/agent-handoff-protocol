/** A JSON Schema for the output fields an adapter asks its tool to report: each required, each text or a list of text; null for no fields. */
export function outputSchemaFor(fields: readonly string[]): object | null {
  if (fields.length === 0) return null;
  const text = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
  return { type: "object", properties: Object.fromEntries(fields.map((name) => [name, text])), required: [...fields], additionalProperties: false };
}
