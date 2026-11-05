import { z } from "zod";
import {
  canvasRuntimeJsonValueSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeSourceEvidenceSchema,
  storedCanvasRuntimeCommandSchema
} from "@planweave-ai/agent-host-protocol";

const originalCanvasRuntimeRequestSchema = canvasRuntimeRequestCommandSchema
  .omit({ protocolVersion: true, operation: true })
  .extend({
    protocolVersion: z.literal(1),
    operation: z.discriminatedUnion("operation", [
      z.object({ operation: z.literal("availability") }).strict(),
      z
        .object({
          operation: z.literal("acquire"),
          expectedEvidence: canvasRuntimeSourceEvidenceSchema.omit({ operationId: true }).optional()
        })
        .strict(),
      z
        .object({
          operation: z.literal("resolve_work_items"),
          input: canvasRuntimeJsonValueSchema
        })
        .strict()
    ])
  });

export const storedCanvasRuntimeCommandIdentitySchema = z
  .union([storedCanvasRuntimeCommandSchema, originalCanvasRuntimeRequestSchema])
  .transform(({ type, protocolVersion, requestId }) => ({ type, protocolVersion, requestId }));

export function isStoredCanvasRuntimeCommand(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    (input.type === "canvas_runtime.request" || input.type === "canvas_runtime.cancel")
  );
}
