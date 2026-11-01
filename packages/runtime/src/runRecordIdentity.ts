import { z } from "zod";
import { parseBlockRef } from "./graph/blockRef.js";

export function runRecordId(blockRef: string, runId: string): string {
  return `${blockRef}::${runId}`;
}

export function feedbackRunRecordId(feedbackId: string, runId: string): string {
  return `${feedbackId}::${runId}`;
}

export type ParsedRunRecordId = z.infer<typeof runRecordIdentitySchema>;

export function parseRunRecordId(recordId: string): ParsedRunRecordId {
  const [ref, runId, extra] = recordId.split("::");
  if (!ref || !runId || extra !== undefined) {
    throw new Error(`Run record id '${recordId}' is invalid.`);
  }
  if (ref.includes("#")) {
    parseBlockRef(ref);
    return { kind: "block", blockRef: ref, runId };
  }
  return { kind: "feedback", feedbackId: ref, runId };
}

export const runRecordIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("block"),
      blockRef: z
        .string()
        .min(1)
        .refine((value) => {
          try {
            parseBlockRef(value);
            return true;
          } catch {
            return false;
          }
        }),
      runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    })
    .strict(),
  z
    .object({
      kind: z.literal("feedback"),
      feedbackId: z.string().regex(/^FE-[A-Za-z0-9._:-]+$/),
      runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    })
    .strict()
]);

export function canonicalRunRecordId(rawIdentity: unknown): string {
  const identity = runRecordIdentitySchema.parse(rawIdentity);
  return identity.kind === "block"
    ? runRecordId(identity.blockRef, identity.runId)
    : feedbackRunRecordId(identity.feedbackId, identity.runId);
}
