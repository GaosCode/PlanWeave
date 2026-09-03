import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import {
  humanPrincipalIdSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import {
  remoteAgentAccessModeSchema,
  remoteAgentGrantRevisionSchema,
  remoteAgentPolicyRevisionSchema,
  type RemoteAgentRecord,
  type RemoteAgentWorkspaceGrantRecord
} from "./schema.js";

export const remoteAgentManagementGrantViewSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    grantRevision: remoteAgentGrantRevisionSchema
  })
  .strict();

export const remoteAgentManagementAgentViewSchema = z
  .object({
    endpointId: opaqueIdentifierSchema,
    hostId: opaqueIdentifierSchema,
    displayName: z.string().trim().min(1).max(128),
    accessMode: remoteAgentAccessModeSchema,
    allowOwnerCanvas: z.boolean(),
    ownershipRepairRequired: z.boolean(),
    ownerHumanPrincipalId: humanPrincipalIdSchema.nullable(),
    policyRevision: remoteAgentPolicyRevisionSchema,
    revokedAt: z.iso.datetime().nullable(),
    grants: z.array(remoteAgentManagementGrantViewSchema)
  })
  .strict();

export const remoteAgentManagementListSchema = z
  .object({
    schemaVersion: z.literal("remote-agent-management-list/v1"),
    items: z.array(remoteAgentManagementAgentViewSchema)
  })
  .strict();

export const operatorRemoteAgentListQuerySchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema
  })
  .strict();

export const operatorRemoteAgentAccessModeRequestSchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    accessMode: remoteAgentAccessModeSchema,
    allowOwnerCanvas: z.boolean().optional(),
    expectedPolicyRevision: remoteAgentPolicyRevisionSchema.optional()
  })
  .strict();

export const operatorRemoteAgentGrantRequestSchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    workspaceId: workspaceIdSchema,
    expectedGrantRevision: remoteAgentGrantRevisionSchema.optional()
  })
  .strict();

export const operatorRemoteAgentActorRequestSchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema
  })
  .strict();

export const operatorRemoteAgentRepairOwnershipRequestSchema = z
  .object({
    ownerHumanPrincipalId: humanPrincipalIdSchema
  })
  .strict();

export type RemoteAgentManagementAgentView = z.infer<typeof remoteAgentManagementAgentViewSchema>;
export type RemoteAgentManagementList = z.infer<typeof remoteAgentManagementListSchema>;

export function toRemoteAgentManagementAgentView(
  agent: RemoteAgentRecord,
  grants: readonly RemoteAgentWorkspaceGrantRecord[]
): RemoteAgentManagementAgentView {
  return remoteAgentManagementAgentViewSchema.parse({
    endpointId: agent.endpointId,
    hostId: agent.hostId,
    displayName: agent.displayName,
    accessMode: agent.accessMode,
    allowOwnerCanvas: agent.allowOwnerCanvas,
    ownershipRepairRequired: agent.ownershipRepairRequired,
    ownerHumanPrincipalId: agent.ownerHumanPrincipalId,
    policyRevision: agent.policyRevision,
    revokedAt: agent.revokedAt,
    grants: grants
      .filter((grant) => grant.revokedAt === null)
      .map((grant) => ({
        workspaceId: grant.workspaceId,
        grantRevision: grant.grantRevision
      }))
  });
}

export function toRemoteAgentManagementList(
  items: readonly RemoteAgentManagementAgentView[]
): RemoteAgentManagementList {
  return remoteAgentManagementListSchema.parse({
    schemaVersion: "remote-agent-management-list/v1",
    items
  });
}
