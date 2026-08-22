import { z } from "zod";
import { HUMAN_OBSERVER_PROTOCOL_VERSION } from "./limits.js";
import {
  activityIdSchema,
  commentIdSchema,
  humanProjectIdSchema,
  opaqueIdentifierSchema,
  timestampSchema,
  workItemRefSchema
} from "./primitives.js";
import { canvasContentDigestSchema, canvasRevisionSchema } from "./canvasCommands.js";
import { canvasRuntimeRevisionSchema } from "./runtimeStatus.js";

/**
 * Distinct human observer channel — not Host mailbox, not ACP streams.
 * Path: WSS `/api/v1/projects/:projectId/human/observe`
 * Auth: `Authorization: Bearer pw_hdev_…` on upgrade (same device credential).
 */

export const humanObserverProtocolVersionSchema = z.literal(HUMAN_OBSERVER_PROTOCOL_VERSION);

export const humanObserverCursorSchema = z.number().int().nonnegative();
export type HumanObserverCursor = z.infer<typeof humanObserverCursorSchema>;

export const humanObserverHelloSchema = z
  .object({
    type: z.literal("human.observer.hello"),
    protocolVersion: humanObserverProtocolVersionSchema,
    projectId: humanProjectIdSchema,
    /** Last validated cursor; 0 means start from current head after welcome. */
    lastCursor: humanObserverCursorSchema.default(0)
  })
  .strict();
export type HumanObserverHello = z.infer<typeof humanObserverHelloSchema>;

export const humanObserverWelcomeSchema = z
  .object({
    type: z.literal("human.observer.welcome"),
    protocolVersion: humanObserverProtocolVersionSchema,
    projectId: humanProjectIdSchema,
    serverTime: timestampSchema,
    /** Inclusive high-water mark after catch-up window for this connection. */
    cursor: humanObserverCursorSchema
  })
  .strict();
export type HumanObserverWelcome = z.infer<typeof humanObserverWelcomeSchema>;

export const humanObserverInvalidateKindSchema = z.enum([
  "membership",
  "invitation",
  "assignment",
  "comment",
  "activity",
  "attachment",
  "remote_run",
  "project",
  "canvas",
  "runtime"
]);

/**
 * Bounded invalidation / progress event for Desktop cache refresh.
 * Never embeds secrets, prompts, ACP token streams, or Host mailbox payloads.
 */
export const humanObserverEventSchema = z
  .object({
    type: z.literal("human.observer.event"),
    protocolVersion: humanObserverProtocolVersionSchema,
    cursor: humanObserverCursorSchema,
    previousCursor: humanObserverCursorSchema,
    occurredAt: timestampSchema,
    kind: humanObserverInvalidateKindSchema,
    workItem: workItemRefSchema.optional(),
    commentId: commentIdSchema.optional(),
    activityId: activityIdSchema.optional(),
    humanPrincipalId: opaqueIdentifierSchema.optional(),
    dispatchId: opaqueIdentifierSchema.optional(),
    canvasId: opaqueIdentifierSchema.optional(),
    canvasRevision: canvasRevisionSchema.optional(),
    canvasContentDigest: canvasContentDigestSchema.optional(),
    runtimeRevision: canvasRuntimeRevisionSchema.optional(),
    /** Opaque status token for remote-run progress (not ACP stream content). */
    remoteRunStatus: z
      .enum(["started", "progress", "succeeded", "failed", "interrupted"])
      .optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.cursor <= value.previousCursor) {
      ctx.addIssue({
        code: "custom",
        message: "observer event cursor must advance",
        path: ["cursor"]
      });
    }
    if (value.kind === "canvas") {
      if (
        value.canvasId === undefined ||
        value.canvasRevision === undefined ||
        value.canvasContentDigest === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: "canvas observer event requires canvas id, revision, and content digest",
          path: ["canvasId"]
        });
      }
      if (value.runtimeRevision !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "runtimeRevision is only valid for runtime observer events",
          path: ["runtimeRevision"]
        });
      }
      return;
    }
    if (value.kind === "runtime") {
      if (value.canvasId === undefined || value.runtimeRevision === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "runtime observer event requires canvas id and runtime revision",
          path: ["runtimeRevision"]
        });
      }
      if (value.canvasRevision !== undefined || value.canvasContentDigest !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "runtime observer events must not carry content revision fields",
          path: ["canvasRevision"]
        });
      }
      return;
    }
    if (
      value.canvasId !== undefined ||
      value.canvasRevision !== undefined ||
      value.canvasContentDigest !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "canvas observer fields are only valid for canvas events",
        path: ["canvasId"]
      });
    }
    if (value.runtimeRevision !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "runtimeRevision is only valid for runtime observer events",
        path: ["runtimeRevision"]
      });
    }
  });
export type HumanObserverEvent = z.infer<typeof humanObserverEventSchema>;

/**
 * Server signals that the client's lastCursor is before retained history.
 * Client must perform a bounded authoritative HTTP refresh, then resume from `resumeCursor`.
 */
export const humanObserverCatchupRequiredSchema = z
  .object({
    type: z.literal("human.observer.catchup_required"),
    protocolVersion: humanObserverProtocolVersionSchema,
    reason: z.enum(["retention_gap", "cursor_ahead", "reset"]),
    resumeCursor: humanObserverCursorSchema,
    droppedThroughCursor: humanObserverCursorSchema.optional()
  })
  .strict();
export type HumanObserverCatchupRequired = z.infer<typeof humanObserverCatchupRequiredSchema>;

export const humanObserverAuthExpiredSchema = z
  .object({
    type: z.literal("human.observer.auth_expired"),
    protocolVersion: humanObserverProtocolVersionSchema,
    code: z.enum(["human_device_expired", "human_device_revoked", "human_auth_unauthenticated"])
  })
  .strict();

export const humanObserverPingSchema = z
  .object({
    type: z.literal("human.observer.ping"),
    protocolVersion: humanObserverProtocolVersionSchema
  })
  .strict();

export const humanObserverPongSchema = z
  .object({
    type: z.literal("human.observer.pong"),
    protocolVersion: humanObserverProtocolVersionSchema,
    serverTime: timestampSchema
  })
  .strict();

export const humanObserverClientMessageSchema = z.discriminatedUnion("type", [
  humanObserverHelloSchema,
  humanObserverPingSchema
]);
export type HumanObserverClientMessage = z.infer<typeof humanObserverClientMessageSchema>;

export const humanObserverServerMessageSchema = z.discriminatedUnion("type", [
  humanObserverWelcomeSchema,
  humanObserverEventSchema,
  humanObserverCatchupRequiredSchema,
  humanObserverAuthExpiredSchema,
  humanObserverPongSchema
]);
export type HumanObserverServerMessage = z.infer<typeof humanObserverServerMessageSchema>;

export function parseHumanObserverClientMessage(input: unknown): HumanObserverClientMessage {
  return humanObserverClientMessageSchema.parse(input);
}

export function parseHumanObserverServerMessage(input: unknown): HumanObserverServerMessage {
  return humanObserverServerMessageSchema.parse(input);
}
