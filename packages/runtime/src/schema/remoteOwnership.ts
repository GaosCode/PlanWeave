import {
  dispatchIdSchema,
  executionAttemptIdSchema,
  interruptionReasonSchema,
  normalizedFailureSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import { remoteExecutionControlPlaneSchema } from "./remoteExecutionControlPlane.js";

export { remoteExecutionControlPlaneSchema } from "./remoteExecutionControlPlane.js";
export type { RemoteExecutionControlPlane } from "./remoteExecutionControlPlane.js";

const remoteOwnershipSourceShape = {
  operationId: opaqueIdentifierSchema,
  sourceRevision: opaqueIdentifierSchema,
  graphFingerprint: opaqueIdentifierSchema,
  /** Absent only on durable records written before Owner fleet dispatch existed. */
  controlPlane: remoteExecutionControlPlaneSchema.optional()
};

/** Durable ownership recorded before a Coordinator dispatch exists. */
export const preparingRemoteBlockOwnershipSchema = z
  .object({
    phase: z.literal("preparing"),
    ...remoteOwnershipSourceShape
  })
  .strict();

/** Exact dispatch and execution-attempt binding activated for the same operation. */
export const activeRemoteBlockOwnershipSchema = z
  .object({
    phase: z.literal("active"),
    ...remoteOwnershipSourceShape,
    dispatchId: dispatchIdSchema,
    executionAttemptId: executionAttemptIdSchema
  })
  .strict();

export const remoteBlockOwnershipSchema = z.discriminatedUnion("phase", [
  preparingRemoteBlockOwnershipSchema,
  activeRemoteBlockOwnershipSchema
]);

const activeRemoteOperationIdentityShape = {
  operationId: opaqueIdentifierSchema,
  sourceRevision: opaqueIdentifierSchema,
  graphFingerprint: opaqueIdentifierSchema,
  controlPlane: remoteExecutionControlPlaneSchema.optional(),
  dispatchId: dispatchIdSchema,
  executionAttemptId: executionAttemptIdSchema
};

const remoteOperationReceiptBlockTypeSchema = z.enum(["implementation", "review"]);

export const remoteOperationReceiptSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      ...activeRemoteOperationIdentityShape,
      runId: opaqueIdentifierSchema,
      /** Present on new receipts; used to detect manifest type drift at the same ref. */
      blockType: remoteOperationReceiptBlockTypeSchema.optional()
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failed"),
      ...activeRemoteOperationIdentityShape,
      failure: normalizedFailureSchema,
      blockType: remoteOperationReceiptBlockTypeSchema.optional()
    })
    .strict()
]);

export const remoteInterruptionSchema = z
  .object({
    reason: interruptionReasonSchema,
    resumable: z.boolean()
  })
  .strict();

const remoteAttemptIdentityShape = {
  dispatchId: dispatchIdSchema,
  executionAttemptId: executionAttemptIdSchema
};

const boundRemoteRetryReceiptSchema = z
  .object({
    outcome: z.enum(["committed", "source_rejected"]),
    ...remoteAttemptIdentityShape,
    newDispatchId: dispatchIdSchema,
    newExecutionAttemptId: executionAttemptIdSchema
  })
  .strict()
  .refine(
    (receipt) =>
      receipt.dispatchId !== receipt.newDispatchId &&
      receipt.executionAttemptId !== receipt.newExecutionAttemptId,
    "Remote retry must replace both dispatch and execution attempt identities."
  );

export const remoteRetryReceiptSchema = z.discriminatedUnion("outcome", [
  boundRemoteRetryReceiptSchema,
  z
    .object({
      outcome: z.enum(["source_invalidated", "active_source_invalidated"]),
      ...remoteAttemptIdentityShape
    })
    .strict()
]);

export type PreparingRemoteBlockOwnership = z.infer<typeof preparingRemoteBlockOwnershipSchema>;
export type PreparingRemoteBlockOwnershipInput = z.input<
  typeof preparingRemoteBlockOwnershipSchema
>;
export type ActiveRemoteBlockOwnership = z.infer<typeof activeRemoteBlockOwnershipSchema>;
export type ActiveRemoteBlockOwnershipInput = z.input<typeof activeRemoteBlockOwnershipSchema>;
export type RemoteBlockOwnership = z.infer<typeof remoteBlockOwnershipSchema>;
export type RemoteOperationReceipt = z.infer<typeof remoteOperationReceiptSchema>;
export type RemoteInterruption = z.infer<typeof remoteInterruptionSchema>;
export type BoundRemoteRetryReceipt = z.infer<typeof boundRemoteRetryReceiptSchema>;
export type RemoteRetryReceipt = z.infer<typeof remoteRetryReceiptSchema>;
