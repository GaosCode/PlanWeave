import {
  ACP_EVENT_BATCH_MAX_COUNT,
  acpEventCursorSchema,
  acpRecoveryIdentitySchema,
  blockRefSchema,
  dispatchIdSchema,
  executionAttemptIdSchema,
  interactionRequestSchema,
  interactionSettlementSchema,
  leaseIdSchema,
  normalizedAcpEventSchema,
  normalizedFailureSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import { collaborationRevisionSchema, responsibilitySchemaVersion } from "./responsibility.js";
import { executionTargetSchemaVersion } from "./executionTarget.js";
import { timestampSchema, workItemRefSchema } from "./primitives.js";
import { availableRemoteAgentEndpointSchema } from "./agentEndpoint.js";

/**
 * Human-facing remote ACP run observation / control wire contracts.
 * Distinct from Host mailbox streams and from local Runtime Auto Run records.
 * Server domain may keep operator-shaped internals; Desktop parses these public views.
 */

export const remoteOperationStateSchema = z.enum([
  "preparing",
  "claimed",
  "reserved",
  "activated",
  "running",
  "interrupted",
  "action_required",
  "awaiting_writeback",
  "completed",
  "failed",
  "cancelled"
]);
export type RemoteOperationState = z.infer<typeof remoteOperationStateSchema>;

export const remoteAttemptStatusSchema = z.enum([
  "prepared",
  "reserved",
  "activated",
  "running",
  "interrupted",
  "action_required",
  "awaiting_writeback",
  "superseded",
  "completed",
  "failed",
  "cancelled"
]);
export type RemoteAttemptStatus = z.infer<typeof remoteAttemptStatusSchema>;

export const remoteDispatchStatusSchema = z.enum([
  "leased",
  "running",
  "interrupted",
  "cancelling",
  "awaiting_writeback",
  "completed",
  "failed",
  "cancelled"
]);
export type RemoteDispatchStatus = z.infer<typeof remoteDispatchStatusSchema>;

/** Safe Runtime binding projection for human observation (no paths/tokens). */
export const remoteRuntimeBindingProjectionSchema = z
  .object({
    ref: blockRefSchema,
    status: z.string().min(1).max(64),
    ownership: z
      .object({
        operationId: opaqueIdentifierSchema,
        phase: z.enum(["preparing", "active"]).optional(),
        dispatchId: dispatchIdSchema.optional(),
        executionAttemptId: executionAttemptIdSchema.optional()
      })
      .strict()
      .optional(),
    interruption: z
      .object({
        reason: z.string().min(1).max(128),
        resumable: z.boolean(),
        recovery: acpRecoveryIdentitySchema.optional()
      })
      .strict()
      .optional(),
    terminalReceipt: z
      .object({
        operationId: opaqueIdentifierSchema.optional(),
        outcome: z.enum(["completed", "failed", "blocked", "cancelled"]).optional(),
        summary: z.string().max(4_096).optional()
      })
      .strict()
      .optional(),
    blockedReason: z.string().max(4_096).nullable().optional(),
    divergenceReason: z.string().max(4_096).nullable().optional()
  })
  .strict();
export type RemoteRuntimeBindingProjection = z.infer<typeof remoteRuntimeBindingProjectionSchema>;

export const remoteAttemptViewSchema = z
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
export type RemoteAttemptView = z.infer<typeof remoteAttemptViewSchema>;

export const remoteOperationDiagnosticStageSchema = z.enum([
  "authorizing",
  "resolving_endpoint",
  "reserving_host",
  "attaching_runtime",
  "preparing_runtime",
  "materializing",
  "dispatching",
  "running",
  "writing_back",
  "cancelling",
  "terminal"
]);
export type RemoteOperationDiagnosticStage = z.infer<typeof remoteOperationDiagnosticStageSchema>;

/** Redacted, Server-derived diagnostics. Never contains Host IDs, paths, credentials, or logs. */
export const remoteOperationDiagnosticsSchema = z
  .object({
    stage: remoteOperationDiagnosticStageSchema,
    /** Monotonic Server persistence order from remote_operation_events.sequence. */
    revision: z.number().int().positive(),
    attemptId: executionAttemptIdSchema,
    locator: z
      .object({
        workspaceId: opaqueIdentifierSchema,
        projectId: opaqueIdentifierSchema,
        canvasId: opaqueIdentifierSchema
      })
      .strict(),
    endpointId: opaqueIdentifierSchema.optional(),
    hostGeneration: z
      .string()
      .regex(/^hostgen:sha256:[a-f0-9]{16}$/)
      .optional(),
    authorityRevisions: z
      .object({
        responsibility: z.number().int().nonnegative(),
        reviewer: z.number().int().nonnegative(),
        executionTarget: z.number().int().nonnegative().optional()
      })
      .strict()
      .optional(),
    content: z
      .object({
        revision: opaqueIdentifierSchema,
        fingerprint: opaqueIdentifierSchema
      })
      .strict(),
    reservation: z
      .object({ status: z.enum(["pending", "active", "released"]) })
      .strict()
      .optional(),
    attachment: z
      .object({ status: z.enum(["preparing", "active"]) })
      .strict()
      .optional(),
    lease: z
      .object({
        status: z.enum(["active", "released"]),
        expiresAt: timestampSchema.optional()
      })
      .strict()
      .optional(),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    terminalAt: timestampSchema.optional(),
    timeoutAt: timestampSchema.optional(),
    error: z
      .object({
        code: opaqueIdentifierSchema,
        retryable: z.boolean()
      })
      .strict()
      .optional()
  })
  .strict();
export type RemoteOperationDiagnostics = z.infer<typeof remoteOperationDiagnosticsSchema>;

export const remoteOperationObservationSchema = z
  .object({
    operationId: opaqueIdentifierSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema,
    state: remoteOperationStateSchema,
    dispatchId: dispatchIdSchema,
    executionAttemptId: executionAttemptIdSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    terminalAt: timestampSchema.optional(),
    attempt: remoteAttemptViewSchema,
    dispatchStatus: remoteDispatchStatusSchema.optional(),
    failure: normalizedFailureSchema.optional(),
    /** Optional only for rolling compatibility; current Server observations always provide it. */
    diagnostics: remoteOperationDiagnosticsSchema.optional(),
    agentEndpoint: availableRemoteAgentEndpointSchema
      .extend({ resolvedAt: timestampSchema })
      .strict()
      .optional(),
    /** Runtime authority projection — never merged into Server lifecycle as truth. */
    runtime: remoteRuntimeBindingProjectionSchema
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
export type RemoteOperationObservation = z.infer<typeof remoteOperationObservationSchema>;

export const remoteEndpointOperationObservationSchema = remoteOperationObservationSchema.refine(
  (observation) => observation.agentEndpoint !== undefined,
  { message: "endpoint_observation_required", path: ["agentEndpoint"] }
);

export const remoteDispatchWireCommandSchema = z
  .object({
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema,
    idempotencyKey: z.string().min(1).max(256),
    requestedHostId: opaqueIdentifierSchema.optional(),
    allowHumanOverride: z.boolean().optional(),
    expectedAssignmentRevision: z.number().int().nonnegative().optional()
  })
  .strict();
export type RemoteDispatchWireCommand = z.infer<typeof remoteDispatchWireCommandSchema>;

/**
 * Legacy v1 input retained solely for migration. It mixes human and Host targets
 * through optional fields and must not be used as the new dispatch authority.
 */
export const legacyRemoteDispatchWireCommandSchema = remoteDispatchWireCommandSchema;
export type LegacyRemoteDispatchWireCommand = RemoteDispatchWireCommand;

/**
 * Legacy v2 Desktop intent retained for migration and recovery reads only.
 * Actor/auth/lease are Server-owned. New dispatch writes must use v3.
 */
export const legacyRemoteDispatchIntentV2Schema = z
  .object({
    schemaVersion: z.literal("remote-run/v2"),
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema,
    idempotencyKey: z.string().trim().min(1).max(256),
    expectedResponsibilityRevision: collaborationRevisionSchema,
    /** 0 when no reviewer is assigned; never null — null is not "don't care". */
    expectedReviewerRevision: collaborationRevisionSchema,
    expectedExecutionTargetRevision: collaborationRevisionSchema
  })
  .strict();
export type LegacyRemoteDispatchIntentV2 = z.infer<typeof legacyRemoteDispatchIntentV2Schema>;

/** @deprecated Use only to read legacy v2 dispatch intents during migration or recovery. */
export const remoteDispatchIntentSchema = legacyRemoteDispatchIntentV2Schema;
/** @deprecated Use `LegacyRemoteDispatchIntentV2` only for migration or recovery reads. */
export type RemoteDispatchIntent = LegacyRemoteDispatchIntentV2;
/** @deprecated New dispatch writes must use `remoteDispatchWireCommandV3Schema`. */
export const remoteDispatchWireCommandV2Schema = legacyRemoteDispatchIntentV2Schema;
/** @deprecated Use only to read legacy v2 dispatch intents during migration or recovery. */
export const remoteBlockDispatchIntentSchema = legacyRemoteDispatchIntentV2Schema;
/** @deprecated New dispatch writes must use `RemoteDispatchIntentV3`. */
export type RemoteDispatchWireCommandV2 = LegacyRemoteDispatchIntentV2;

/** Current write intent: one opaque Agent Endpoint, never a caller-selected Host. */
export const remoteDispatchIntentV3Schema = z
  .object({
    schemaVersion: z.literal("remote-run/v3"),
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema,
    agentEndpointId: opaqueIdentifierSchema,
    idempotencyKey: z.string().trim().min(1).max(256),
    expectedResponsibilityRevision: collaborationRevisionSchema,
    expectedReviewerRevision: collaborationRevisionSchema
  })
  .strict();
export type RemoteDispatchIntentV3 = z.infer<typeof remoteDispatchIntentV3Schema>;
export const remoteDispatchWireCommandV3Schema = remoteDispatchIntentV3Schema;

/**
 * Migration-only parser for persisted intents across v2 and v3.
 * @deprecated New dispatch writes must parse with `remoteDispatchIntentV3Schema` directly.
 */
export const remoteDispatchVersionedIntentSchema = z.discriminatedUnion("schemaVersion", [
  legacyRemoteDispatchIntentV2Schema,
  remoteDispatchIntentV3Schema
]);
/** @deprecated Use only for migration or recovery reads across persisted intent versions. */
export type RemoteDispatchVersionedIntent = z.infer<typeof remoteDispatchVersionedIntentSchema>;

/** Version markers carried by the three independent assignment authorities. */
export const remoteDispatchAuthorityVersionsSchema = z
  .object({
    responsibility: z.literal(responsibilitySchemaVersion),
    reviewer: z.literal("review-assignment/v1"),
    executionTarget: z.literal(executionTargetSchemaVersion)
  })
  .strict();
export type RemoteDispatchAuthorityVersions = z.infer<typeof remoteDispatchAuthorityVersionsSchema>;

const actionReasonSchema = z.string().trim().min(1).max(4_096);
const actionIdSchema = opaqueIdentifierSchema;
const expectedAttemptVersionSchema = z.number().int().nonnegative();

const actionIdentityShape = {
  actionId: actionIdSchema,
  operationId: opaqueIdentifierSchema,
  dispatchId: dispatchIdSchema,
  executionAttemptId: executionAttemptIdSchema,
  expectedAttemptVersion: expectedAttemptVersionSchema
};

export const remoteExecutionActionWireRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("resume_same_session"),
      priorLeaseId: leaseIdSchema,
      leaseId: leaseIdSchema,
      leaseExpiresAt: timestampSchema,
      recovery: acpRecoveryIdentitySchema,
      reason: actionReasonSchema
    })
    .strict()
    .refine((action) => action.priorLeaseId !== action.leaseId, {
      message: "Resume requires a fresh lease identity.",
      path: ["leaseId"]
    }),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("retry_new_attempt"),
      priorLeaseId: leaseIdSchema,
      newDispatchId: dispatchIdSchema,
      newExecutionAttemptId: executionAttemptIdSchema,
      reason: actionReasonSchema
    })
    .strict()
    .refine((action) => action.executionAttemptId !== action.newExecutionAttemptId, {
      message: "Retry requires a new execution attempt identity.",
      path: ["newExecutionAttemptId"]
    })
    .refine((action) => action.dispatchId !== action.newDispatchId, {
      message: "Retry requires a new dispatch identity.",
      path: ["newDispatchId"]
    }),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("fail"),
      leaseId: leaseIdSchema,
      failure: normalizedFailureSchema,
      reason: actionReasonSchema
    })
    .strict(),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("block"),
      leaseId: leaseIdSchema,
      reason: actionReasonSchema
    })
    .strict(),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("cancel"),
      leaseId: leaseIdSchema,
      reason: actionReasonSchema
    })
    .strict()
]);
export type RemoteExecutionActionWireRequest = z.infer<
  typeof remoteExecutionActionWireRequestSchema
>;

/**
 * Human Desktop action intent. Server-owned resume lease and recovery fields are
 * deliberately excluded; the Server materializes the complete action request
 * after revalidating the observed operation state.
 */
export const remoteHumanExecutionActionCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("resume_same_session"),
      priorLeaseId: leaseIdSchema,
      reason: actionReasonSchema
    })
    .strict(),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("retry_new_attempt"),
      priorLeaseId: leaseIdSchema,
      newDispatchId: dispatchIdSchema,
      newExecutionAttemptId: executionAttemptIdSchema,
      reason: actionReasonSchema
    })
    .strict()
    .refine((action) => action.executionAttemptId !== action.newExecutionAttemptId, {
      message: "Retry requires a new execution attempt identity.",
      path: ["newExecutionAttemptId"]
    })
    .refine((action) => action.dispatchId !== action.newDispatchId, {
      message: "Retry requires a new dispatch identity.",
      path: ["newDispatchId"]
    }),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("fail"),
      leaseId: leaseIdSchema,
      failure: normalizedFailureSchema,
      reason: actionReasonSchema
    })
    .strict(),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("block"),
      leaseId: leaseIdSchema,
      reason: actionReasonSchema
    })
    .strict(),
  z
    .object({
      ...actionIdentityShape,
      kind: z.literal("cancel"),
      leaseId: leaseIdSchema,
      reason: actionReasonSchema
    })
    .strict()
]);
export type RemoteHumanExecutionActionCommand = z.infer<
  typeof remoteHumanExecutionActionCommandSchema
>;

export const remoteExecutionActionStateSchema = z.enum([
  "recorded",
  "delivered",
  "acknowledged",
  "settled",
  "rejected"
]);
export type RemoteExecutionActionState = z.infer<typeof remoteExecutionActionStateSchema>;
export const remoteExecutionActionRejectionCodeSchema = z.enum(["work_not_agent_assigned"]);
export type RemoteExecutionActionRejectionCode = z.infer<
  typeof remoteExecutionActionRejectionCodeSchema
>;

export const remoteActionViewSchema = z
  .object({
    request: remoteExecutionActionWireRequestSchema,
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
      context.addIssue({ code: "custom", message: "remote_action_rejection_state_mismatch" });
    }
  });
export type RemoteActionView = z.infer<typeof remoteActionViewSchema>;

export const remoteEventReplaySchema = z
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
      .optional()
  })
  .strict();
export type RemoteEventReplay = z.infer<typeof remoteEventReplaySchema>;

export const remoteEventQuerySchema = z
  .object({
    afterCursor: z.number().int().nonnegative().default(0)
  })
  .strict();
export type RemoteEventQuery = z.infer<typeof remoteEventQuerySchema>;

export const remoteInteractionViewSchema = z
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
export type RemoteInteractionView = z.infer<typeof remoteInteractionViewSchema>;

export const remoteInteractionPageSchema = z
  .object({
    items: z.array(remoteInteractionViewSchema).max(100),
    nextCursor: z.number().int().positive().nullable()
  })
  .strict();
export type RemoteInteractionPage = z.infer<typeof remoteInteractionPageSchema>;

export const remoteInteractionPageQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict();
export type RemoteInteractionPageQuery = z.infer<typeof remoteInteractionPageQuerySchema>;

export const remoteInteractionResponseSchema = interactionSettlementSchema;
export type RemoteInteractionResponse = z.infer<typeof remoteInteractionResponseSchema>;

/** Optional lookup helper when UI knows WorkItemRef + optional operationId. */
export const remoteOperationLookupQuerySchema = z
  .object({
    canvasId: opaqueIdentifierSchema.optional(),
    workItem: workItemRefSchema.optional(),
    blockRef: blockRefSchema.optional(),
    operationId: opaqueIdentifierSchema.optional(),
    dispatchId: opaqueIdentifierSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.operationId && !value.dispatchId && !value.blockRef && !value.workItem) {
      ctx.addIssue({
        code: "custom",
        message: "Remote operation lookup requires at least one identity field."
      });
    }
  });
export type RemoteOperationLookupQuery = z.infer<typeof remoteOperationLookupQuerySchema>;
