import {
  blockRefSchema,
  interactionRequestSchema,
  interactionSettlementSchema,
  normalizedAcpEventSchema,
  remoteRunnerEventV2Schema
} from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(256);
const contentRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const graphFingerprintSchema = z.string().regex(/^pkg-[a-f0-9]{64}$/);
const bindingIdSchema = z.string().regex(/^wxb:sha256:[a-f0-9]{64}$/);
const canonicalServerOriginSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).origin === value, "workspace_execution_origin_not_canonical");

export const workspaceExecutionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("task"), taskId: identifierSchema }).strict(),
  z.object({ kind: z.literal("block"), blockRef: blockRefSchema }).strict()
]);

const expectedContentSchema = z
  .object({ contentRevision: contentRevisionSchema, graphFingerprint: graphFingerprintSchema })
  .strict();

const packageAuthorityLocatorShape = {
  packageWorkspace: z.string().trim().min(1).max(4_096),
  expected: expectedContentSchema
};

export const workspaceContentAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("package_snapshot"), ...packageAuthorityLocatorShape }).strict(),
  z.object({ kind: z.literal("server_canvas") }).strict()
]);

export const localWorkspaceAuthorityLocatorSchema = z
  .object({ kind: z.literal("local_package"), ...packageAuthorityLocatorShape })
  .strict();

export const remoteWorkspaceAuthorityLocatorSchema = z
  .object({
    kind: z.literal("workspace_canvas"),
    contentAuthority: workspaceContentAuthoritySchema,
    connectionProfileId: identifierSchema,
    serverOrigin: canonicalServerOriginSchema,
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema
  })
  .strict();

export const workspaceExecutionAuthorityLocatorSchema = z.discriminatedUnion("kind", [
  localWorkspaceAuthorityLocatorSchema,
  remoteWorkspaceAuthorityLocatorSchema
]);

export const workspaceAuthorityRevisionsSchema = z
  .object({
    responsibilityRevision: z.number().int().nonnegative(),
    reviewerRevision: z.number().int().nonnegative(),
    executionTargetRevision: z.number().int().nonnegative()
  })
  .strict();

const bindingBaseShape = {
  version: z.literal("planweave.workspace-authority-binding/v1"),
  bindingId: bindingIdSchema,
  contentRevision: contentRevisionSchema,
  graphFingerprint: graphFingerprintSchema
};

export const localWorkspaceAuthorityBindingSchema = z
  .object({
    ...bindingBaseShape,
    kind: z.literal("local"),
    packageWorkspace: z.string().trim().min(1).max(4_096),
    canvasId: identifierSchema,
    scope: workspaceExecutionScopeSchema
  })
  .strict();

export const remoteWorkspaceAuthorityBindingSchema = z
  .object({
    ...bindingBaseShape,
    kind: z.literal("remote"),
    contentAuthority: workspaceContentAuthoritySchema,
    connectionProfileId: identifierSchema,
    serverOrigin: canonicalServerOriginSchema,
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema,
    blockRef: blockRefSchema,
    authorityRevisions: workspaceAuthorityRevisionsSchema
  })
  .strict();

const legacyRemoteWorkspaceAuthorityBindingV1Schema = z
  .object({
    ...bindingBaseShape,
    kind: z.literal("remote"),
    packageWorkspace: z.string().trim().min(1).max(4_096),
    connectionProfileId: identifierSchema,
    serverOrigin: canonicalServerOriginSchema,
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema,
    blockRef: blockRefSchema,
    authorityRevisions: workspaceAuthorityRevisionsSchema
  })
  .strict();

export const workspaceAuthorityBindingSchema = z.discriminatedUnion("kind", [
  localWorkspaceAuthorityBindingSchema,
  remoteWorkspaceAuthorityBindingSchema
]);

export const workspaceExecutionTargetRequestSchema = z
  .object({
    policy: z.enum(["local", "remote"]),
    agentEndpointId: identifierSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.policy === "local" && value.agentEndpointId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["agentEndpointId"],
        message: "local_execution_cannot_select_remote_endpoint"
      });
    }
  });

export const effectiveWorkspaceExecutorSchema = z
  .object({ name: identifierSchema, agentId: identifierSchema })
  .strict();

export const workspaceExecutionRequestSchema = z
  .object({
    authority: workspaceExecutionAuthorityLocatorSchema,
    scope: workspaceExecutionScopeSchema,
    trigger: z.enum(["manual", "skill", "cli", "desktop", "api"]),
    target: workspaceExecutionTargetRequestSchema,
    executorOverride: identifierSchema.optional(),
    effectiveExecutor: effectiveWorkspaceExecutorSchema.optional(),
    eventFormat: z.enum(["legacy", "execution-v1"])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.target.policy === "local" && value.authority.kind !== "local_package") {
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "local_authority_required"
      });
    }
    if (value.target.policy !== "local" && value.authority.kind !== "workspace_canvas") {
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "remote_authority_required"
      });
    }
    if (value.target.policy !== "local" && value.scope.kind !== "block") {
      context.addIssue({ code: "custom", path: ["scope"], message: "remote_block_scope_required" });
    }
    if (value.target.policy !== "local" && value.effectiveExecutor === undefined) {
      context.addIssue({
        code: "custom",
        path: ["effectiveExecutor"],
        message: "remote_effective_executor_required"
      });
    }
  });

const remoteEndpointTargetSchema = z
  .object({
    target: z.literal("remote"),
    agentEndpointId: identifierSchema,
    agentProfileId: identifierSchema,
    agentId: identifierSchema
  })
  .strict();

export const workspaceExecutionTargetSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("local") }).strict(),
  remoteEndpointTargetSchema
]);

export const workspaceExecutionCursorSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("local"), sequence: z.number().int().nonnegative() }).strict(),
  z
    .object({
      target: z.literal("remote"),
      executionAttemptId: identifierSchema.nullable(),
      eventCursor: z.number().int().nonnegative()
    })
    .strict()
]);

const handleBaseShape = {
  version: z.literal("planweave.workspace-execution-handle/v1"),
  runSessionId: z.string().regex(/^SESSION-\d{4,}$/),
  authorityBindingId: bindingIdSchema,
  scope: workspaceExecutionScopeSchema,
  capabilities: z.object({ interactionResponse: z.boolean() }).strict()
};

export const localWorkspaceExecutionHandleSchema = z
  .object({
    ...handleBaseShape,
    target: z.literal("local"),
    localRunId: z.string().trim().min(1).max(256),
    cursor: workspaceExecutionCursorSchema.options[0]
  })
  .strict();

export const remoteWorkspaceExecutionHandleSchema = z
  .object({
    ...handleBaseShape,
    target: z.literal("remote"),
    phase: z.enum(["operation", "attempt", "acp_session"]),
    operationId: identifierSchema,
    operationRevision: z.number().int().nonnegative(),
    dispatchId: identifierSchema,
    executionAttemptId: identifierSchema.nullable(),
    attemptStateVersion: z.number().int().nonnegative().nullable(),
    leaseId: identifierSchema.nullable(),
    agentEndpointId: identifierSchema,
    cursor: workspaceExecutionCursorSchema.options[1]
  })
  .strict()
  .superRefine((value, context) => {
    if (value.executionAttemptId !== value.cursor.executionAttemptId) {
      context.addIssue({
        code: "custom",
        path: ["cursor", "executionAttemptId"],
        message: "workspace_execution_attempt_cursor_mismatch"
      });
    }
    if (value.phase === "operation" && value.executionAttemptId !== null) {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "workspace_execution_operation_phase_has_attempt"
      });
    }
    if (value.phase !== "operation" && value.executionAttemptId === null) {
      context.addIssue({
        code: "custom",
        path: ["executionAttemptId"],
        message: "workspace_execution_attempt_phase_missing_attempt"
      });
    }
    if ((value.executionAttemptId === null) !== (value.attemptStateVersion === null)) {
      context.addIssue({
        code: "custom",
        path: ["attemptStateVersion"],
        message: "workspace_execution_attempt_version_mismatch"
      });
    }
  });

export const workspaceExecutionHandleSchema = z.discriminatedUnion("target", [
  localWorkspaceExecutionHandleSchema,
  remoteWorkspaceExecutionHandleSchema
]);

const remoteDispatchIntentStateSchema = z
  .object({
    schemaVersion: z.literal("remote-run/v3"),
    projectId: identifierSchema,
    canvasId: identifierSchema,
    blockRef: blockRefSchema,
    agentEndpointId: identifierSchema,
    idempotencyKey: identifierSchema,
    expectedResponsibilityRevision: z.number().int().nonnegative(),
    expectedReviewerRevision: z.number().int().nonnegative(),
    executionTargetRevision: z.number().int().nonnegative(),
    contentRevision: contentRevisionSchema,
    graphFingerprint: graphFingerprintSchema
  })
  .strict();

const workspaceExecutionInteractionIdentitySchema = z
  .object({
    key: z.string().regex(/^wxi:sha256:[a-f0-9]{64}$/),
    status: z.enum(["pending", "settled", "expired"])
  })
  .strict();

const workspaceExecutionEvidenceSchema = z
  .object({
    status: z.enum(["pending", "complete", "incomplete"]),
    diagnostics: z
      .array(
        z
          .object({
            code: identifierSchema,
            message: z.string().trim().min(1).max(4_096),
            observedAt: z.string().datetime()
          })
          .strict()
      )
      .max(100)
  })
  .strict();

const workspaceExecutionSessionStateV1Schema = z
  .object({
    version: z.literal("planweave.workspace-execution-session/v1"),
    binding: workspaceAuthorityBindingSchema,
    dispatchIntent: remoteDispatchIntentStateSchema.nullable(),
    observedOperationId: identifierSchema.optional(),
    handle: workspaceExecutionHandleSchema.nullable(),
    interactions: z.array(workspaceExecutionInteractionIdentitySchema).max(10_000),
    evidence: workspaceExecutionEvidenceSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.handle !== null && value.binding.bindingId !== value.handle.authorityBindingId) {
      context.addIssue({
        code: "custom",
        path: ["handle"],
        message: "workspace_execution_binding_mismatch"
      });
    }
    if (value.handle !== null && value.binding.kind !== value.handle.target) {
      context.addIssue({
        code: "custom",
        path: ["handle", "target"],
        message: "workspace_execution_target_mismatch"
      });
    }
    if (
      value.binding.kind === "remote" &&
      value.handle?.target === "remote" &&
      (value.handle.scope.kind !== "block" ||
        value.handle.scope.blockRef !== value.binding.blockRef)
    ) {
      context.addIssue({
        code: "custom",
        path: ["handle", "scope"],
        message: "workspace_execution_scope_mismatch"
      });
    }
    if (
      value.binding.kind === "local" &&
      value.handle?.target === "local" &&
      JSON.stringify(value.handle.scope) !== JSON.stringify(value.binding.scope)
    ) {
      context.addIssue({
        code: "custom",
        path: ["handle", "scope"],
        message: "workspace_execution_scope_mismatch"
      });
    }
    if (value.binding.kind === "remote") {
      if (
        (value.dispatchIntent === null && value.observedOperationId === undefined) ||
        (value.dispatchIntent !== null && value.observedOperationId !== undefined) ||
        (value.observedOperationId !== undefined &&
          value.handle?.target === "remote" &&
          value.handle.operationId !== value.observedOperationId) ||
        (value.dispatchIntent !== null &&
          (value.dispatchIntent.projectId !== value.binding.projectId ||
            value.dispatchIntent.canvasId !== value.binding.canvasId ||
            value.dispatchIntent.blockRef !== value.binding.blockRef ||
            value.dispatchIntent.expectedResponsibilityRevision !==
              value.binding.authorityRevisions.responsibilityRevision ||
            value.dispatchIntent.expectedReviewerRevision !==
              value.binding.authorityRevisions.reviewerRevision ||
            value.dispatchIntent.executionTargetRevision !==
              value.binding.authorityRevisions.executionTargetRevision ||
            value.dispatchIntent.contentRevision !== value.binding.contentRevision ||
            value.dispatchIntent.graphFingerprint !== value.binding.graphFingerprint))
      ) {
        context.addIssue({
          code: "custom",
          path: ["dispatchIntent"],
          message: "workspace_execution_dispatch_intent_mismatch"
        });
      }
    } else if (value.dispatchIntent !== null || value.observedOperationId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["dispatchIntent"],
        message: "local_execution_cannot_have_dispatch_intent"
      });
    }
  });

function normalizeLegacyWorkspaceExecutionSession(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("binding" in value)) return value;
  const legacyBinding = legacyRemoteWorkspaceAuthorityBindingV1Schema.safeParse(value.binding);
  if (!legacyBinding.success) return value;
  const { packageWorkspace, ...binding } = legacyBinding.data;
  return {
    ...value,
    binding: {
      ...binding,
      contentAuthority: {
        kind: "package_snapshot",
        packageWorkspace,
        expected: {
          contentRevision: binding.contentRevision,
          graphFingerprint: binding.graphFingerprint
        }
      }
    }
  };
}

export const workspaceExecutionSessionStateSchema = z.preprocess(
  normalizeLegacyWorkspaceExecutionSession,
  workspaceExecutionSessionStateV1Schema
);

const executionEventSourceSchema = z.discriminatedUnion("target", [
  z
    .object({
      target: z.literal("local"),
      localRunId: identifierSchema,
      sequence: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      target: z.literal("remote"),
      operationId: identifierSchema,
      executionAttemptId: identifierSchema.nullable(),
      cursor: z.number().int().nonnegative()
    })
    .strict()
]);

const executionEventBaseShape = {
  version: z.literal("planweave.execution-event/v1"),
  eventId: z.string().trim().min(1).max(1_024),
  observedAt: z.string().datetime(),
  runSessionId: z.string().regex(/^SESSION-\d{4,}$/),
  scope: workspaceExecutionScopeSchema,
  source: executionEventSourceSchema
};

const runnerEventDataSchema = z.discriminatedUnion("eventProtocolVersion", [
  z.object({ eventProtocolVersion: z.literal(1), event: normalizedAcpEventSchema }).strict(),
  z.object({ eventProtocolVersion: z.literal(2), event: remoteRunnerEventV2Schema }).strict()
]);

const executionSelectedDataSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("local") }).strict(),
  remoteEndpointTargetSchema.extend({ connectionProfileId: identifierSchema }).strict()
]);

export const workspaceExecutionEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("execution_selected"),
      data: executionSelectedDataSchema
    })
    .strict(),
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("operation_observed"),
      data: z
        .object({
          state: identifierSchema,
          attemptStatus: identifierSchema,
          operationRevision: z.number().int().nonnegative()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("attempt_changed"),
      data: z
        .object({
          previousExecutionAttemptId: identifierSchema.nullable(),
          executionAttemptId: identifierSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("runner_event"),
      data: runnerEventDataSchema
    })
    .strict(),
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("runner_diagnostic"),
      data: z
        .object({
          code: identifierSchema,
          message: z.string().max(4_096),
          retryable: z.boolean(),
          stage: identifierSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("interaction_required"),
      data: interactionRequestSchema
    })
    .strict(),
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("action_required"),
      data: z.object({ reason: z.enum(["manual", "blocked", "remote_interaction"]) }).strict()
    })
    .strict(),
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("interaction_resolved"),
      data: interactionSettlementSchema
    })
    .strict(),
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("retention_gap"),
      data: z.object({ droppedThroughCursor: z.number().int().positive() }).strict()
    })
    .strict(),
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("writeback_observed"),
      data: z.object({ state: z.enum(["completed", "failed", "cancelled"]) }).strict()
    })
    .strict(),
  z
    .object({
      ...executionEventBaseShape,
      type: z.literal("run_terminal"),
      data: z.object({ outcome: z.enum(["completed", "failed", "cancelled"]) }).strict()
    })
    .strict()
]);

export type WorkspaceExecutionScope = z.infer<typeof workspaceExecutionScopeSchema>;
export type WorkspaceExecutionAuthorityLocator = z.infer<
  typeof workspaceExecutionAuthorityLocatorSchema
>;
export type LocalWorkspaceAuthorityLocator = z.infer<typeof localWorkspaceAuthorityLocatorSchema>;
export type RemoteWorkspaceAuthorityLocator = z.infer<typeof remoteWorkspaceAuthorityLocatorSchema>;
export type WorkspaceContentAuthority = z.infer<typeof workspaceContentAuthoritySchema>;
export type WorkspaceAuthorityRevisions = z.infer<typeof workspaceAuthorityRevisionsSchema>;
export type WorkspaceAuthorityBinding = z.infer<typeof workspaceAuthorityBindingSchema>;
export type LocalWorkspaceAuthorityBinding = z.infer<typeof localWorkspaceAuthorityBindingSchema>;
export type RemoteWorkspaceAuthorityBinding = z.infer<typeof remoteWorkspaceAuthorityBindingSchema>;
export type WorkspaceExecutionRequest = z.infer<typeof workspaceExecutionRequestSchema>;
export type WorkspaceExecutionTarget = z.infer<typeof workspaceExecutionTargetSchema>;
export type WorkspaceExecutionCursor = z.infer<typeof workspaceExecutionCursorSchema>;
export type WorkspaceExecutionHandle = z.infer<typeof workspaceExecutionHandleSchema>;
export type LocalWorkspaceExecutionHandle = z.infer<typeof localWorkspaceExecutionHandleSchema>;
export type RemoteWorkspaceExecutionHandle = z.infer<typeof remoteWorkspaceExecutionHandleSchema>;
export type WorkspaceExecutionSessionState = z.infer<typeof workspaceExecutionSessionStateSchema>;
export type WorkspaceExecutionDispatchIntent = z.infer<typeof remoteDispatchIntentStateSchema>;
export type WorkspaceExecutionInteractionIdentity = z.infer<
  typeof workspaceExecutionInteractionIdentitySchema
>;
export type WorkspaceExecutionEvent = z.infer<typeof workspaceExecutionEventSchema>;
