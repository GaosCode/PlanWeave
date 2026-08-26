import {
  ACP_EVENT_BATCH_MAX_COUNT,
  acpEventCursorSchema,
  blockRefSchema,
  artifactRefSchema,
  dispatchIdSchema,
  executionAttemptIdSchema,
  executionEnvelopeDigestSchema,
  interactionRequestSchema,
  interactionSettlementSchema,
  leaseIdSchema,
  normalizedAcpEventSchema,
  normalizedFailureSchema,
  opaqueIdentifierSchema,
  operatorEnrollmentGrantRequestSchema,
  operatorEnrollmentGrantResponseSchema,
  operatorHostPageSchema,
  operatorHostRenewalRequestSchema,
  operatorHostRenewalResponseSchema,
  operatorHostViewSchema,
  operatorPageQuerySchema
} from "@planweave-ai/agent-host-protocol";
import {
  humanPrincipalIdSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  remoteDispatchIntentV3Schema,
  remoteOperationDiagnosticsSchema,
  type RemoteDispatchIntentV3
} from "@planweave-ai/collaboration-protocol/remote-run";
import { availableRemoteAgentEndpointSchema } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { remoteBlockBindingViewSchema } from "@planweave-ai/runtime";
import { z } from "zod";
import { dispatchStatusSchema } from "./dispatches.js";
import {
  remoteExecutionActionRejectionCodeSchema,
  remoteExecutionActionRequestSchema,
  remoteExecutionActionStateSchema
} from "./remoteExecutionLifecycle.js";
import { remoteAttemptStatusSchema, remoteOperationStateSchema } from "./remoteOperations.js";

export {
  operatorEnrollmentGrantRequestSchema,
  operatorEnrollmentGrantResponseSchema,
  operatorHostPageSchema,
  operatorHostRenewalRequestSchema,
  operatorHostRenewalResponseSchema,
  operatorHostViewSchema,
  operatorPageQuerySchema
};

const timestampSchema = z.iso.datetime();

export const operatorDispatchRequestSchema = remoteDispatchIntentV3Schema.extend({
  humanPrincipalId: humanPrincipalIdSchema.optional(),
  workspaceId: workspaceIdSchema.optional()
});

export const operatorActionRequestSchema = remoteExecutionActionRequestSchema;
export const operatorInteractionResponseSchema = interactionSettlementSchema;

export const operatorEventQuerySchema = z
  .object({ afterCursor: z.coerce.number().int().nonnegative().default(0) })
  .strict();

const operatorAttemptViewSchema = z
  .object({
    executionAttemptId: executionAttemptIdSchema,
    dispatchId: dispatchIdSchema,
    status: remoteAttemptStatusSchema,
    hostId: opaqueIdentifierSchema.optional(),
    leaseId: leaseIdSchema.optional(),
    leaseExpiresAt: timestampSchema.optional(),
    stateVersion: z.number().int().nonnegative()
  })
  .strict();

export const operatorOperationViewSchema = z
  .object({
    operationId: opaqueIdentifierSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema,
    state: remoteOperationStateSchema,
    dispatchId: dispatchIdSchema,
    executionAttemptId: executionAttemptIdSchema,
    envelopeDigest: executionEnvelopeDigestSchema.optional(),
    reportArtifactRef: artifactRefSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    terminalAt: timestampSchema.optional(),
    agentEndpoint: availableRemoteAgentEndpointSchema
      .extend({ resolvedAt: timestampSchema })
      .strict()
      .optional(),
    attempt: operatorAttemptViewSchema,
    dispatchStatus: dispatchStatusSchema.optional(),
    failure: normalizedFailureSchema.optional(),
    diagnostics: remoteOperationDiagnosticsSchema,
    runtime: remoteBlockBindingViewSchema
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.agentEndpoint && observation.attempt.hostId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["attempt", "hostId"],
        message: "endpoint_observation_must_redact_host_id"
      });
    }
  });

export const operatorActionViewSchema = z
  .object({
    request: operatorActionRequestSchema,
    state: remoteExecutionActionStateSchema,
    createdAt: timestampSchema,
    deliveredAt: timestampSchema.optional(),
    acknowledgedAt: timestampSchema.optional(),
    settledAt: timestampSchema.optional(),
    rejectedAt: timestampSchema.optional(),
    rejectionCode: remoteExecutionActionRejectionCodeSchema.optional()
  })
  .strict()
  .superRefine((action, context) => {
    const hasRejection = action.rejectedAt !== undefined || action.rejectionCode !== undefined;
    if (
      (action.state === "rejected" &&
        (action.rejectedAt === undefined || action.rejectionCode === undefined)) ||
      (action.state !== "rejected" && hasRejection)
    ) {
      context.addIssue({ code: "custom", message: "operator_action_rejection_state_mismatch" });
    }
  });

export const operatorEventReplaySchema = z
  .object({
    executionAttemptId: opaqueIdentifierSchema,
    afterCursor: acpEventCursorSchema,
    cursor: acpEventCursorSchema,
    highWatermark: acpEventCursorSchema,
    hasMore: z.boolean(),
    events: z.array(normalizedAcpEventSchema).max(ACP_EVENT_BATCH_MAX_COUNT),
    diagnostics: z
      .array(
        z
          .object({
            code: z.literal("remote_acp_event_retention_gap"),
            droppedThroughCursor: z.number().int().positive()
          })
          .strict()
      )
      .max(1)
  })
  .strict();

export const operatorInteractionViewSchema = z
  .object({
    request: interactionRequestSchema,
    operationId: opaqueIdentifierSchema,
    hostId: opaqueIdentifierSchema,
    status: z.enum(["pending", "settled", "expired"]),
    createdAt: timestampSchema,
    settlement: interactionSettlementSchema.optional(),
    settledBy: opaqueIdentifierSchema.optional(),
    settledAt: timestampSchema.optional()
  })
  .strict();

export const operatorInteractionPageSchema = z
  .object({
    items: z.array(operatorInteractionViewSchema).max(100),
    nextCursor: z.number().int().positive().nullable()
  })
  .strict();

export type OperatorEnrollmentGrantRequest = z.infer<typeof operatorEnrollmentGrantRequestSchema>;
export type OperatorDispatchRequest = RemoteDispatchIntentV3;
export type OperatorActionRequest = z.infer<typeof operatorActionRequestSchema>;
export type OperatorInteractionResponse = z.infer<typeof operatorInteractionResponseSchema>;
export type OperatorOperationView = z.infer<typeof operatorOperationViewSchema>;
