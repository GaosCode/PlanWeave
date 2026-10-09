import { z } from "zod";
import { collaborationBoundaryErrorSchema } from "@planweave-ai/collaboration-protocol/errors";

export const collaborationCommandErrorSchema = collaborationBoundaryErrorSchema
  .extend({
    message: z.string().min(1).max(512)
  })
  .strict();
export type CollaborationCommandError = z.infer<typeof collaborationCommandErrorSchema>;

export type CollaborationCommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CollaborationCommandError };

export function collaborationCommandResultSchema<T>(valueSchema: z.ZodType<T>) {
  return z.discriminatedUnion("ok", [
    z
      .object({
        ok: z.literal(true),
        value: valueSchema
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        error: collaborationCommandErrorSchema
      })
      .strict()
  ]);
}

export function unwrapCollaborationCommandResult<T>(input: unknown, valueSchema: z.ZodType<T>): T {
  const parsed = collaborationCommandResultSchema(valueSchema).parse(input);
  if (parsed.ok) return parsed.value;
  throw parsed.error;
}
