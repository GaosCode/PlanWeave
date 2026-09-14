import { z } from "zod";
import {
  CANVAS_PRESENCE_COORDINATE_ABS_MAX,
  CANVAS_PRESENCE_MAX_SELECTION_IDS,
  CANVAS_PRESENCE_MAX_SESSIONS_PER_CANVAS,
  CANVAS_PRESENCE_PROTOCOL_VERSION,
  CANVAS_PRESENCE_SELECTION_ID_MAX_LENGTH
} from "./limits.js";
import {
  humanDisplayNameSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  opaqueIdentifierSchema
} from "./primitives.js";

/**
 * Ephemeral multi-cursor / selection presence only.
 * Messages never carry operationId, expectedRevision, journal entries, content digests,
 * or durable graph mutation intents. Durable shared Canvas edits use `canvasCommands.ts`.
 */

export const canvasPresenceProtocolVersionSchema = z.literal(CANVAS_PRESENCE_PROTOCOL_VERSION);

export const canvasPresenceSessionIdSchema =
  opaqueIdentifierSchema.brand("CanvasPresenceSessionId");
export type CanvasPresenceSessionId = z.infer<typeof canvasPresenceSessionIdSchema>;

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const canvasPresenceSelectionIdSchema = z
  .string()
  .min(1)
  .max(CANVAS_PRESENCE_SELECTION_ID_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, "selection id must not be blank")
  .refine(
    (value) => !hasAsciiControlCharacter(value),
    "selection id must not contain control characters"
  );
export type CanvasPresenceSelectionId = z.infer<typeof canvasPresenceSelectionIdSchema>;

export const canvasPresenceSelectionIdsSchema = z
  .array(canvasPresenceSelectionIdSchema)
  .max(CANVAS_PRESENCE_MAX_SELECTION_IDS)
  .superRefine((selectionIds, context) => {
    if (new Set(selectionIds).size !== selectionIds.length) {
      context.addIssue({ code: "custom", message: "selection ids must be unique" });
    }
  });

const flowCoordinateSchema = z
  .number()
  .finite()
  .min(-CANVAS_PRESENCE_COORDINATE_ABS_MAX)
  .max(CANVAS_PRESENCE_COORDINATE_ABS_MAX);

export const canvasPresencePointerSchema = z
  .object({
    x: flowCoordinateSchema,
    y: flowCoordinateSchema
  })
  .strict();
export type CanvasPresencePointer = z.infer<typeof canvasPresencePointerSchema>;

export const canvasPresenceDisplayNameSchema = humanDisplayNameSchema.refine(
  (value) => !hasAsciiControlCharacter(value),
  "presence display name must not contain control characters"
);

/** Server-created public identity; device credential ids and secrets are never projected. */
export const canvasPresenceSessionIdentitySchema = z
  .object({
    sessionId: canvasPresenceSessionIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: canvasPresenceDisplayNameSchema
  })
  .strict();
export type CanvasPresenceSessionIdentity = z.infer<typeof canvasPresenceSessionIdentitySchema>;

export const canvasPresenceSessionSchema = z
  .object({
    identity: canvasPresenceSessionIdentitySchema,
    pointer: canvasPresencePointerSchema.nullable(),
    selectionIds: canvasPresenceSelectionIdsSchema
  })
  .strict();
export type CanvasPresenceSession = z.infer<typeof canvasPresenceSessionSchema>;

const canvasPresenceScopeShape = {
  protocolVersion: canvasPresenceProtocolVersionSchema,
  projectId: humanProjectIdSchema,
  canvasId: opaqueIdentifierSchema
} as const;

/** Opt-in diagnostics contain ephemeral correlation identifiers, never identity or authority. */
export const PRESENCE_TRANSPORT_DIAGNOSTICS_HEADER = "x-planweave-presence-transport-diagnostics";
export const PRESENCE_TRANSPORT_RECORD_LIMIT = 128;
export const PRESENCE_PROBE_INTERVAL_MS = 500;
export const PRESENCE_PROBE_LEASE_MS = 2000;
export const PRESENCE_PROBE_TIMEOUT_MS = 5000;
export const PRESENCE_PROBE_PENDING_LIMIT = 12;
export const PRESENCE_DIAGNOSTICS_HEADER = "x-planweave-presence-diagnostics";
export const canvasPresenceTraceSchema = z
  .object({
    streamId: z.string().uuid(),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict();
export const canvasPresenceServerTraceSchema = canvasPresenceTraceSchema
  .extend({
    serverClockId: z.string().uuid(),
    serverReceivedMs: z.number().finite().nonnegative(),
    serverForwardedMs: z.number().finite().nonnegative()
  })
  .strict()
  .refine((value) => value.serverForwardedMs >= value.serverReceivedMs);
export type CanvasPresenceTrace = z.infer<typeof canvasPresenceTraceSchema>;
export type CanvasPresenceServerTrace = z.infer<typeof canvasPresenceServerTraceSchema>;

/** Write completion is local transport completion, never proof of peer delivery. */
export const canvasPresenceTransportRecordSchema = z
  .object({
    stage: z.enum(["write", "event_loop"]),
    atMs: z.number().finite().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
    bufferedBytes: z.number().int().nonnegative().optional(),
    failed: z.boolean().optional(),
    trace: canvasPresenceServerTraceSchema.optional()
  })
  .strict();
export type CanvasPresenceTransportRecord = z.infer<typeof canvasPresenceTransportRecordSchema>;
export const canvasPresenceTransportReportSchema = z
  .object({
    probeId: z.string().uuid(),
    serverClockId: z.string().uuid(),
    serverReceivedMs: z.number().finite().nonnegative(),
    serverRespondedMs: z.number().finite().nonnegative(),
    bufferedBytes: z.number().int().nonnegative(),
    droppedRecords: z.number().int().nonnegative(),
    pendingWrites: z.number().int().nonnegative(),
    connection: z
      .object({
        serverPort: z.number().int().min(1).max(65535),
        clientPort: z.number().int().min(1).max(65535)
      })
      .strict()
      .optional(),
    records: z.array(canvasPresenceTransportRecordSchema).max(PRESENCE_TRANSPORT_RECORD_LIMIT)
  })
  .strict()
  .refine((v) => v.serverRespondedMs >= v.serverReceivedMs);
export type CanvasPresenceTransportReport = z.infer<typeof canvasPresenceTransportReportSchema>;
export const canvasPresenceProbeSchema = z
  .object({
    type: z.literal("canvas.presence.probe"),
    ...canvasPresenceScopeShape,
    probeId: z.string().uuid(),
    captureToken: z.string().uuid()
  })
  .strict();
export const canvasPresenceProbeResultSchema = z
  .object({
    type: z.literal("canvas.presence.probe_result"),
    ...canvasPresenceScopeShape,
    report: canvasPresenceTransportReportSchema
  })
  .strict();

export const canvasPresenceProbeErrorSchema = z
  .object({
    type: z.literal("canvas.presence.probe_error"),
    ...canvasPresenceScopeShape,
    probeId: z.string().uuid(),
    code: z.literal("rate_limited")
  })
  .strict();

/** Client introduction contains routing only; authenticated identity is never client supplied. */
export const canvasPresenceHelloSchema = z
  .object({
    type: z.literal("canvas.presence.hello"),
    ...canvasPresenceScopeShape
  })
  .strict();
export type CanvasPresenceHello = z.infer<typeof canvasPresenceHelloSchema>;

export const canvasPresenceSnapshotSchema = z
  .object({
    type: z.literal("canvas.presence.snapshot"),
    ...canvasPresenceScopeShape,
    diagnosticsVersion: z.literal(1).optional(),
    transportDiagnosticsVersion: z.literal(1).optional(),
    sessions: z.array(canvasPresenceSessionSchema).max(CANVAS_PRESENCE_MAX_SESSIONS_PER_CANVAS)
  })
  .strict()
  .superRefine((snapshot, context) => {
    const sessionIds = snapshot.sessions.map((session) => session.identity.sessionId);
    if (new Set(sessionIds).size !== sessionIds.length) {
      context.addIssue({
        code: "custom",
        message: "presence snapshot session ids must be unique",
        path: ["sessions"]
      });
    }
  });
export type CanvasPresenceSnapshot = z.infer<typeof canvasPresenceSnapshotSchema>;

/** Client update excludes every trusted identity field. */
export const canvasPresenceClientUpdateSchema = z
  .object({
    type: z.literal("canvas.presence.update"),
    ...canvasPresenceScopeShape,
    pointer: canvasPresencePointerSchema.nullable(),
    selectionIds: canvasPresenceSelectionIdsSchema,
    trace: canvasPresenceTraceSchema.optional()
  })
  .strict();
export type CanvasPresenceClientUpdate = z.infer<typeof canvasPresenceClientUpdateSchema>;

/** Server update carries the identity derived from the authenticated device membership. */
export const canvasPresenceUpdateSchema = z
  .object({
    type: z.literal("canvas.presence.update"),
    ...canvasPresenceScopeShape,
    session: canvasPresenceSessionSchema,
    trace: canvasPresenceServerTraceSchema.optional()
  })
  .strict();
export type CanvasPresenceUpdate = z.infer<typeof canvasPresenceUpdateSchema>;

export const canvasPresenceLeaveSchema = z
  .object({
    type: z.literal("canvas.presence.leave"),
    ...canvasPresenceScopeShape,
    sessionId: canvasPresenceSessionIdSchema
  })
  .strict();
export type CanvasPresenceLeave = z.infer<typeof canvasPresenceLeaveSchema>;

export const canvasPresenceErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "unknown_canvas",
  "cross_scope",
  "unsupported_version",
  "invalid_message",
  "frame_too_large",
  "rate_limited",
  "capacity_exceeded",
  "server_error"
]);
export type CanvasPresenceErrorCode = z.infer<typeof canvasPresenceErrorCodeSchema>;

export const canvasPresenceErrorSchema = z
  .object({
    type: z.literal("canvas.presence.error"),
    ...canvasPresenceScopeShape,
    code: canvasPresenceErrorCodeSchema
  })
  .strict();
export type CanvasPresenceError = z.infer<typeof canvasPresenceErrorSchema>;

export const canvasPresenceClientMessageSchema = z.discriminatedUnion("type", [
  canvasPresenceHelloSchema,
  canvasPresenceClientUpdateSchema,
  canvasPresenceProbeSchema
]);
export type CanvasPresenceClientMessage = z.infer<typeof canvasPresenceClientMessageSchema>;

export const canvasPresenceServerMessageSchema = z.discriminatedUnion("type", [
  canvasPresenceSnapshotSchema,
  canvasPresenceUpdateSchema,
  canvasPresenceLeaveSchema,
  canvasPresenceErrorSchema,
  canvasPresenceProbeResultSchema,
  canvasPresenceProbeErrorSchema
]);
export type CanvasPresenceServerMessage = z.infer<typeof canvasPresenceServerMessageSchema>;

export function parseCanvasPresenceClientMessage(input: unknown): CanvasPresenceClientMessage {
  return canvasPresenceClientMessageSchema.parse(input);
}

export function parseCanvasPresenceServerMessage(input: unknown): CanvasPresenceServerMessage {
  return canvasPresenceServerMessageSchema.parse(input);
}
