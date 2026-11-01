import { z } from "zod";
import {
  acpConversationEventSchema,
  acpConversationTurnSchema
} from "@planweave-ai/agent-host-protocol";

export const legacyAcpConversationRevision = "fe2fed5a";
const identifier = z.string().min(1).max(256);
export const legacyAcpConversationPageSchema = z
  .object({
    available: z.boolean(),
    canRestoreTask: z.boolean().default(false),
    restoredOperationId: identifier.nullable().default(null),
    reason: z.string().nullable(),
    executionAttemptId: identifier,
    sessionId: z.string().min(1).max(1024).nullable(),
    turns: z.array(acpConversationTurnSchema),
    events: z.array(acpConversationEventSchema),
    cursor: z.number().int().nonnegative().safe(),
    hasMore: z.boolean(),
    retention: z
      .object({ compactedTurnIds: z.array(identifier).min(1).max(256) })
      .strict()
      .optional()
  })
  .strict();

export function legacyConversationRoute(pathname: string): boolean {
  return (
    /^\/api\/v1\/remote-operations\/([^/]+)(?:\/(actions|events|interactions|terminal-result|conversation)(\/respond)?)?$/.test(
      pathname
    ) ||
    /^\/api\/v1\/projects\/([^/]+)\/remote-operations(?:\/([^/]+)(?:\/(actions|events|interactions|conversation)(\/respond)?)?)?$/.test(
      pathname
    )
  );
}
