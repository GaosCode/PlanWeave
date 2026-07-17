import { z } from "zod";
import {
  acpEventSubscriptionCloseResultSchema,
  type AcpEventSubscriptionCloseResult
} from "../../autoRun/acpEventPublisher.js";
import { runnerEventCursorSchema } from "../../autoRun/runnerEventReplay.js";
import { runnerRecordReadModelSchema } from "../../autoRun/runnerRecordReadModelContract.js";
import {
  runnerInteractionActionIdentitySchema,
  runnerInteractionClientLabelSchema,
  runnerInteractionErrorCodeSchema,
  runnerInteractionResponseReceiptSchema,
  runnerInteractionSnapshotSchema,
  runnerPermissionInteractionDecisionSchema,
  type RunnerInteractionActionIdentity,
  type RunnerInteractionResponseReceipt,
  type RunnerInteractionSnapshot,
  type RunnerPermissionInteractionDecision
} from "../../autoRun/runnerInteractionContract.js";
import {
  runnerRequestActionIdentitySchema,
  runnerSessionActionIdentitySchema
} from "../../autoRun/runnerContractSchemas.js";
import type { RunnerRecordReadModel } from "../../autoRun/runnerRecordReadModelContract.js";
import {
  desktopAgentPromptIdentitySchema,
  type DesktopAgentPromptIdentity
} from "../../autoRun/runnerRecordReadModelContract.js";

const nonEmptyStringSchema = z.string().min(1).max(4_096);

export const runnerInteractionCanvasRefSchema = z
  .object({
    projectRoot: z.string().min(1),
    canvasId: z.string().min(1).nullable().optional()
  })
  .strict();
export type RunnerInteractionCanvasRef = z.infer<typeof runnerInteractionCanvasRefSchema>;

export const runnerInteractionAuditSchema = z
  .object({
    decisionSource: runnerInteractionClientLabelSchema,
    reason: z.string().min(1).max(4096).nullable()
  })
  .strict();
export type RunnerInteractionAudit = z.infer<typeof runnerInteractionAuditSchema>;

export {
  runnerInteractionActionIdentitySchema,
  runnerInteractionResponseReceiptSchema,
  runnerInteractionSnapshotSchema,
  runnerPermissionInteractionDecisionSchema
};
export type {
  RunnerInteractionActionIdentity,
  RunnerInteractionResponseReceipt,
  RunnerInteractionSnapshot,
  RunnerPermissionInteractionDecision
};

export const runnerInteractionIpcErrorSchema = z
  .object({
    code: runnerInteractionErrorCodeSchema,
    message: z.string().min(1).max(4096),
    details: z.json().nullable()
  })
  .strict();
export type RunnerInteractionIpcError = z.infer<typeof runnerInteractionIpcErrorSchema>;

export const listPendingRunnerInteractionsResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.array(runnerInteractionSnapshotSchema) }).strict(),
  z.object({ ok: z.literal(false), error: runnerInteractionIpcErrorSchema }).strict()
]);
export type ListPendingRunnerInteractionsResult = z.infer<
  typeof listPendingRunnerInteractionsResultSchema
>;

export const respondToRunnerInteractionResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: runnerInteractionResponseReceiptSchema }).strict(),
  z.object({ ok: z.literal(false), error: runnerInteractionIpcErrorSchema }).strict()
]);
export type RespondToRunnerInteractionResult = z.infer<
  typeof respondToRunnerInteractionResultSchema
>;

export const desktopRunnerRecordSubscriptionInputSchema = z
  .object({
    subscriptionId: nonEmptyStringSchema.max(256),
    ref: z
      .object({
        projectRoot: nonEmptyStringSchema,
        canvasId: nonEmptyStringSchema.max(256).nullable().optional()
      })
      .strict(),
    recordId: nonEmptyStringSchema.max(1_024),
    cursor: runnerEventCursorSchema.optional()
  })
  .strict();
export type DesktopRunnerRecordSubscriptionInput = z.infer<
  typeof desktopRunnerRecordSubscriptionInputSchema
>;

export const desktopRunnerRecordSubscriptionSnapshotPushSchema = z
  .object({
    kind: z.literal("snapshot"),
    subscriptionId: nonEmptyStringSchema.max(256),
    updateSequence: z.number().int().positive(),
    snapshot: runnerRecordReadModelSchema
  })
  .strict();

export const desktopRunnerRecordSubscriptionClosedPushSchema = z
  .object({
    kind: z.literal("closed"),
    subscriptionId: nonEmptyStringSchema.max(256),
    updateSequence: z.number().int().positive(),
    close: acpEventSubscriptionCloseResultSchema
  })
  .strict();

export const desktopRunnerRecordSubscriptionPushSchema = z.discriminatedUnion("kind", [
  desktopRunnerRecordSubscriptionSnapshotPushSchema,
  desktopRunnerRecordSubscriptionClosedPushSchema
]);
export type DesktopRunnerRecordSubscriptionPush = z.infer<
  typeof desktopRunnerRecordSubscriptionPushSchema
>;

export type DesktopRunnerRecordSubscriptionStart = {
  subscriptionId: string;
  updateSequence: 0;
  snapshot: RunnerRecordReadModel | null;
};

export type DesktopRunnerRecordSubscriptionUpdate =
  | {
      kind: "snapshot";
      updateSequence: number;
      snapshot: RunnerRecordReadModel;
    }
  | {
      kind: "closed";
      updateSequence: number;
      close: AcpEventSubscriptionCloseResult;
    };

export const desktopAgentSessionActionIdentitySchema = runnerSessionActionIdentitySchema;
export type DesktopAgentSessionActionIdentity = z.infer<
  typeof desktopAgentSessionActionIdentitySchema
>;

export const desktopAgentActionIdentitySchema = runnerRequestActionIdentitySchema;
export type DesktopAgentActionIdentity = z.infer<typeof desktopAgentActionIdentitySchema>;

export const desktopAgentActionValueSchema = z.json();
export type DesktopAgentActionValue = z.infer<typeof desktopAgentActionValueSchema>;

export type DesktopPendingAgentRequest = {
  requestId: string;
  interactionId: string;
  kind: "permission" | "authentication" | "elicitation";
  requestedAt: string;
  summary: string;
};

export { desktopAgentPromptIdentitySchema };
export type { DesktopAgentPromptIdentity };

export const desktopAgentPromptTextSchema = z
  .string()
  .min(1)
  .max(64 * 1_024)
  .refine((value) => value.trim().length > 0, "ACP prompt text must not be blank.");
