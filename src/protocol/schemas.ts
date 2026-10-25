import { z } from "zod";
import { HandoffRevisionSchema, RejectionReasonSchema } from "./handoff.ts";

/**
 * The JSON Schemas (draft 2020-12) generated from the protocol's Zod schemas, by published file name. The files
 * under `schemas/` are the published protocol artifact; `npm run schemas` regenerates them from this function.
 */
export function protocolJsonSchemas(): Record<string, object> {
  const toJsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-2020-12" });
  return {
    "handoff-revision.schema.json": toJsonSchema(HandoffRevisionSchema),
    "rejection-reason.schema.json": toJsonSchema(RejectionReasonSchema),
  };
}
