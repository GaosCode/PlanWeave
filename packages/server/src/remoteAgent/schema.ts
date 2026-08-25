import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import {
  remoteAgentAuthorizationErrorCodeSchema,
  remoteAgentEndpointAccessViewSchema,
  type RemoteAgentAuthorizationErrorCode,
  type RemoteAgentEndpointAccessView
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  agentHostIdSchema,
  humanPrincipalIdSchema,
  timestampSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";

export const remoteAgentAccessModeSchema = z.enum(["unrestricted", "workspace_restricted"]);

/** Durable policy version. 0 is absence and is never stored. */
export const remoteAgentPolicyRevisionSchema = z.number().int().min(1);

/** Durable grant version. 0 is absence and is never stored. */
export const remoteAgentGrantRevisionSchema = z.number().int().min(1);

/**
 * Persistent Remote Agent identity. UNIQUE(hostId, profileId, agentId);
 * `endpointId` is the derived primary key and never includes workspaceId.
 * Repair-required agents may omit an owner; dispatch refuses them (Phase 2).
 */
export const remoteAgentRecordSchema = z
  .object({
    endpointId: opaqueIdentifierSchema,
    hostId: agentHostIdSchema,
    profileId: opaqueIdentifierSchema,
    agentId: opaqueIdentifierSchema,
    ownerHumanPrincipalId: humanPrincipalIdSchema.nullable(),
    displayName: z.string().trim().min(1).max(128),
    accessMode: remoteAgentAccessModeSchema,
    policyRevision: remoteAgentPolicyRevisionSchema,
    ownershipRepairRequired: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revokedAt: timestampSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.ownershipRepairRequired && value.ownerHumanPrincipalId === null) {
      context.addIssue({
        code: "custom",
        message: "owner_human_principal_id_required",
        path: ["ownerHumanPrincipalId"]
      });
    }
    if (
      value.accessMode === "unrestricted" &&
      (value.ownerHumanPrincipalId === null || value.ownershipRepairRequired)
    ) {
      context.addIssue({
        code: "custom",
        message: "unrestricted_requires_owner",
        path: ["accessMode"]
      });
    }
  });

/** Persistent Workspace Grant. PRIMARY KEY(endpointId, workspaceId). */
export const remoteAgentWorkspaceGrantRecordSchema = z
  .object({
    endpointId: opaqueIdentifierSchema,
    workspaceId: workspaceIdSchema,
    grantRevision: remoteAgentGrantRevisionSchema,
    grantedByHumanPrincipalId: humanPrincipalIdSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revokedAt: timestampSchema.nullable()
  })
  .strict();

export const runtimeAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner_canvas") }).strict(),
  z
    .object({
      kind: z.literal("workspace_canvas"),
      workspaceId: workspaceIdSchema
    })
    .strict()
]);

export const agentAccessAuthoritySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("agent_owner"),
      ownerHumanPrincipalId: humanPrincipalIdSchema,
      policyRevision: remoteAgentPolicyRevisionSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace_grant"),
      workspaceId: workspaceIdSchema,
      grantRevision: remoteAgentGrantRevisionSchema,
      policyRevision: remoteAgentPolicyRevisionSchema
    })
    .strict()
]);

/** Persisted Agent Access Authority. Same union as live authorize(); stored in agent_access_json. */
export const agentAccessAuthoritySnapshotSchema = agentAccessAuthoritySchema;

export const authorizedRemoteAgentUseSchema = z
  .object({
    remoteAgent: z
      .object({
        endpointId: opaqueIdentifierSchema,
        hostId: agentHostIdSchema,
        profileId: opaqueIdentifierSchema,
        agentId: opaqueIdentifierSchema
      })
      .strict(),
    runtimeAuthority: runtimeAuthoritySchema,
    agentAccessAuthority: agentAccessAuthoritySchema,
    resolvedAt: timestampSchema
  })
  .strict();

/**
 * Catalog/dispatch canvas locator (plan RemoteExecutionTarget).
 * Owner-canvas Agent grant never uses the internal runtime workspaceId.
 */
export const remoteAgentUseTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("owner_canvas"),
      projectId: opaqueIdentifierSchema,
      canvasId: opaqueIdentifierSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace_canvas"),
      workspaceId: workspaceIdSchema,
      projectId: opaqueIdentifierSchema,
      canvasId: opaqueIdentifierSchema
    })
    .strict()
]);

/** Durable dispatch snapshot: caller + AuthorizedRemoteAgentUse. Sibling of endpoint-selection. */
export const persistedRemoteAgentAccessSnapshotSchema = z
  .object({
    callerHumanPrincipalId: humanPrincipalIdSchema,
    authorized: authorizedRemoteAgentUseSchema
  })
  .strict();

export { remoteAgentAuthorizationErrorCodeSchema, remoteAgentEndpointAccessViewSchema };

export type RemoteAgentAccessMode = z.infer<typeof remoteAgentAccessModeSchema>;
export type RemoteAgentPolicyRevision = z.infer<typeof remoteAgentPolicyRevisionSchema>;
export type RemoteAgentGrantRevision = z.infer<typeof remoteAgentGrantRevisionSchema>;
export type RemoteAgentRecord = z.infer<typeof remoteAgentRecordSchema>;
export type RemoteAgentWorkspaceGrantRecord = z.infer<typeof remoteAgentWorkspaceGrantRecordSchema>;
export type RuntimeAuthority = z.infer<typeof runtimeAuthoritySchema>;
export type AgentAccessAuthority = z.infer<typeof agentAccessAuthoritySchema>;
export type AgentAccessAuthoritySnapshot = z.infer<typeof agentAccessAuthoritySnapshotSchema>;
export type AuthorizedRemoteAgentUse = z.infer<typeof authorizedRemoteAgentUseSchema>;
export type RemoteAgentUseTarget = z.infer<typeof remoteAgentUseTargetSchema>;
export type RemoteExecutionTarget = RemoteAgentUseTarget;
export type PersistedRemoteAgentAccessSnapshot = z.infer<
  typeof persistedRemoteAgentAccessSnapshotSchema
>;
export type { RemoteAgentAuthorizationErrorCode, RemoteAgentEndpointAccessView };
