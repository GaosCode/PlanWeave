import {
  ACP_EVENT_BATCH_MAX_COUNT,
  acpEventCursorSchema,
  normalizedAcpEventSchema,
  opaqueIdentifierSchema,
  remoteRunnerEventV2Schema
} from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";

const remoteEventReplayBaseSchema = z.object({
  executionAttemptId: opaqueIdentifierSchema,
  afterCursor: acpEventCursorSchema,
  cursor: acpEventCursorSchema,
  highWatermark: acpEventCursorSchema,
  hasMore: z.boolean()
});
const retentionDiagnosticSchema = z
  .object({
    code: z.literal("remote_acp_event_retention_gap"),
    droppedThroughCursor: z.number().int().positive()
  })
  .strict();
const degradedDiagnosticSchema = z
  .object({ code: z.literal("remote_acp_event_contract_degraded") })
  .strict();

export const remoteEventReplaySchema = z.discriminatedUnion("eventProtocolVersion", [
  remoteEventReplayBaseSchema
    .extend({
      eventProtocolVersion: z.literal(1),
      events: z.array(normalizedAcpEventSchema).max(ACP_EVENT_BATCH_MAX_COUNT),
      diagnostics: z
        .array(z.union([retentionDiagnosticSchema, degradedDiagnosticSchema]))
        .max(2)
        .optional()
    })
    .strict(),
  remoteEventReplayBaseSchema
    .extend({
      eventProtocolVersion: z.literal(2),
      events: z.array(remoteRunnerEventV2Schema).max(ACP_EVENT_BATCH_MAX_COUNT),
      diagnostics: z.array(retentionDiagnosticSchema).max(1).optional()
    })
    .strict()
]);
export type RemoteEventReplay = z.infer<typeof remoteEventReplaySchema>;

export const remoteEventQuerySchema = z
  .object({
    afterCursor: z.number().int().nonnegative().default(0)
  })
  .strict();
export type RemoteEventQuery = z.infer<typeof remoteEventQuerySchema>;
