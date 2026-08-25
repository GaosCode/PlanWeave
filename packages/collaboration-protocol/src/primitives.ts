import { blockRefSchema, opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import {
  HUMAN_ASSIGN_REASON_MAX_LENGTH,
  HUMAN_COMMENT_BODY_MAX_LENGTH,
  HUMAN_COMMENT_BODY_MIN_LENGTH,
  HUMAN_DEVICE_LABEL_MAX_LENGTH,
  HUMAN_DEVICE_MAX_TTL_MS,
  HUMAN_DEVICE_MIN_TTL_MS,
  HUMAN_DEVICE_TOKEN_PREFIX,
  HUMAN_DISPLAY_NAME_MAX_LENGTH,
  HUMAN_DISPLAY_NAME_MIN_LENGTH,
  HUMAN_IDENTITY_TOKEN_PREFIX,
  HUMAN_TOKEN_SECRET_CHAR_LENGTH,
  PROJECT_INVITATION_MAX_TTL_MS,
  PROJECT_INVITATION_MIN_TTL_MS,
  PROJECT_INVITATION_TOKEN_PREFIX,
  SETUP_CODE_MAX_TTL_MS,
  SETUP_CODE_MIN_TTL_MS,
  SETUP_CODE_TOKEN_PREFIX
} from "./limits.js";

export const timestampSchema = z.iso.datetime();

/**
 * Version marker for the Workspace identity contract.  It is deliberately
 * independent from the Agent Host transport protocol version.
 */
export const workspaceIdentitySchemaVersion = "workspace-identity/v1" as const;
export const workspaceIdentitySchemaVersionSchema = z.literal(workspaceIdentitySchemaVersion);
export type WorkspaceIdentitySchemaVersion = z.infer<typeof workspaceIdentitySchemaVersionSchema>;

export const workspaceIdentityMigrationSchemaVersion = "workspace-identity-migration/v1" as const;
export const workspaceIdentityMigrationSchemaVersionSchema = z.literal(
  workspaceIdentityMigrationSchemaVersion
);
export type WorkspaceIdentityMigrationSchemaVersion = z.infer<
  typeof workspaceIdentityMigrationSchemaVersionSchema
>;

export const workspaceIdSchema = opaqueIdentifierSchema.brand("WorkspaceId");
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const humanMembershipIdSchema = opaqueIdentifierSchema.brand("HumanMembershipId");
export type HumanMembershipId = z.infer<typeof humanMembershipIdSchema>;

export const deviceSessionIdSchema = opaqueIdentifierSchema.brand("DeviceSessionId");
export type DeviceSessionId = z.infer<typeof deviceSessionIdSchema>;

export const operatorIdSchema = opaqueIdentifierSchema.brand("OperatorId");
export type OperatorId = z.infer<typeof operatorIdSchema>;

export const operatorSessionIdSchema = opaqueIdentifierSchema.brand("OperatorSessionId");
export type OperatorSessionId = z.infer<typeof operatorSessionIdSchema>;

export const agentHostIdSchema = opaqueIdentifierSchema.brand("AgentHostId");
export type AgentHostId = z.infer<typeof agentHostIdSchema>;

export const hostEnrollmentIdSchema = opaqueIdentifierSchema.brand("HostEnrollmentId");
export type HostEnrollmentId = z.infer<typeof hostEnrollmentIdSchema>;

export const identityRevocationIdSchema = opaqueIdentifierSchema.brand("IdentityRevocationId");
export type IdentityRevocationId = z.infer<typeof identityRevocationIdSchema>;

/**
 * Version marker for one-time Workspace setup-code contracts. Independent from
 * workspace-identity and Host transport protocol versions.
 */
export const workspaceSetupSchemaVersion = "workspace-setup/v1" as const;
export const workspaceSetupSchemaVersionSchema = z.literal(workspaceSetupSchemaVersion);
export type WorkspaceSetupSchemaVersion = z.infer<typeof workspaceSetupSchemaVersionSchema>;

export const setupCodeIdSchema = opaqueIdentifierSchema.brand("SetupCodeId");
export type SetupCodeId = z.infer<typeof setupCodeIdSchema>;

export const setupCodeRevocationIdSchema = opaqueIdentifierSchema.brand("SetupCodeRevocationId");
export type SetupCodeRevocationId = z.infer<typeof setupCodeRevocationIdSchema>;

/**
 * Credential purpose bound to a setup code at issue time. A code redeems into
 * exactly one of these outcomes and never mixes human/operator/Host secrets.
 */
export const setupCredentialPurposeSchema = z.enum([
  "device_session",
  "operator_session",
  "host_enrollment"
]);
export type SetupCredentialPurpose = z.infer<typeof setupCredentialPurposeSchema>;

export const setupCodeLifecycleStateSchema = z.enum([
  "issued",
  "displayed",
  "redeemed",
  "expired",
  "revoked"
]);
export type SetupCodeLifecycleState = z.infer<typeof setupCodeLifecycleStateSchema>;

export const workspaceNameSchema = z.string().trim().min(1).max(128);
export const operatorDisplayNameSchema = z.string().trim().min(1).max(128);

/** Stored credential digests are the only credential representation allowed in durable rows. */
export const credentialSha256Schema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/);
export const tokenSha256HexSchema = credentialSha256Schema;

/** Operator bearer credentials are a separate trust domain from human and Host credentials. */
export const operatorCredentialTokenSchema = z.string().regex(/^pw_operator_[A-Za-z0-9_-]{43}$/);

export const workspaceRoleSchema = z.enum(["owner", "member"]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const identityCredentialStateSchema = z.enum(["active", "expired", "revoked"]);
export type IdentityCredentialState = z.infer<typeof identityCredentialStateSchema>;

/** Workspace-only scope reference.  No paths, commands, or credentials can be carried here. */
export const workspaceScopeRefSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export type WorkspaceScopeRef = z.infer<typeof workspaceScopeRefSchema>;

export const projectScopeRefSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    projectId: opaqueIdentifierSchema
  })
  .strict();
export type ProjectScopeRef = z.infer<typeof projectScopeRefSchema>;

export const canvasScopeRefSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema
  })
  .strict();
export type CanvasScopeRef = z.infer<typeof canvasScopeRefSchema>;

export const blockScopeRefSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema
  })
  .strict();
export type BlockScopeRef = z.infer<typeof blockScopeRefSchema>;

/**
 * Shared boundary helper used by Server authorization and projections.  A scope
 * mismatch is an authorization failure, not a value to coerce or default.
 */
export function assertSameWorkspace(
  expectedWorkspaceId: string,
  ...references: readonly WorkspaceScopeRef[]
): void {
  if (references.some((reference) => reference.workspaceId !== expectedWorkspaceId)) {
    throw new Error("cross_workspace_reference");
  }
}

export function assertCredentialUsable(input: {
  workspaceId: string;
  expectedWorkspaceId: string;
  expiresAt: string | null;
  revokedAt: string | null;
  now: Date;
}): void {
  if (input.workspaceId !== input.expectedWorkspaceId) {
    throw new Error("cross_workspace_credential");
  }
  if (input.revokedAt !== null) throw new Error("credential_revoked");
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= input.now.getTime()) {
    throw new Error("credential_expired");
  }
}

export const humanProjectIdSchema = opaqueIdentifierSchema;
export type HumanProjectId = z.infer<typeof humanProjectIdSchema>;

export const humanPrincipalIdSchema = opaqueIdentifierSchema.brand("HumanPrincipalId");
export type HumanPrincipalId = z.infer<typeof humanPrincipalIdSchema>;

export const humanDeviceCredentialIdSchema =
  opaqueIdentifierSchema.brand("HumanDeviceCredentialId");
export type HumanDeviceCredentialId = z.infer<typeof humanDeviceCredentialIdSchema>;

export const projectMembershipIdSchema = opaqueIdentifierSchema.brand("ProjectMembershipId");
export type ProjectMembershipId = z.infer<typeof projectMembershipIdSchema>;

/** Server-issued opaque references used by the collaboration registry. */
export const projectRegistryIdSchema = opaqueIdentifierSchema.brand("ProjectRegistryId");
export type ProjectRegistryId = z.infer<typeof projectRegistryIdSchema>;

export const canvasRegistryIdSchema = opaqueIdentifierSchema.brand("CanvasRegistryId");
export type CanvasRegistryId = z.infer<typeof canvasRegistryIdSchema>;

export const packageSnapshotIdSchema = opaqueIdentifierSchema.brand("PackageSnapshotId");
export type PackageSnapshotId = z.infer<typeof packageSnapshotIdSchema>;

/** Immutable Server content object identity. The digest relation is enforced by its version schema. */
export const contentVersionIdSchema = opaqueIdentifierSchema.brand("ContentVersionId");
export type ContentVersionId = z.infer<typeof contentVersionIdSchema>;

export const membershipGrantIdSchema = opaqueIdentifierSchema.brand("MembershipGrantId");
export type MembershipGrantId = z.infer<typeof membershipGrantIdSchema>;

export const projectInvitationIdSchema = opaqueIdentifierSchema.brand("ProjectInvitationId");
export type ProjectInvitationId = z.infer<typeof projectInvitationIdSchema>;

export const commentIdSchema = opaqueIdentifierSchema.brand("CommentId");
export type CommentId = z.infer<typeof commentIdSchema>;

export const activityIdSchema = opaqueIdentifierSchema.brand("ActivityId");
export type ActivityId = z.infer<typeof activityIdSchema>;

export const pendingAttachmentUploadIdSchema = opaqueIdentifierSchema.brand(
  "PendingAttachmentUploadId"
);
export type PendingAttachmentUploadId = z.infer<typeof pendingAttachmentUploadIdSchema>;

export const humanDisplayNameSchema = z
  .string()
  .trim()
  .min(HUMAN_DISPLAY_NAME_MIN_LENGTH)
  .max(HUMAN_DISPLAY_NAME_MAX_LENGTH);

export const humanDeviceLabelSchema = z.string().trim().min(1).max(HUMAN_DEVICE_LABEL_MAX_LENGTH);

export const humanCommentBodySchema = z
  .string()
  .min(HUMAN_COMMENT_BODY_MIN_LENGTH)
  .max(HUMAN_COMMENT_BODY_MAX_LENGTH);

export const humanAssignReasonSchema = z.string().min(1).max(HUMAN_ASSIGN_REASON_MAX_LENGTH);

export const humanDeviceTokenSchema = z
  .string()
  .regex(
    new RegExp(`^${HUMAN_DEVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{${HUMAN_TOKEN_SECRET_CHAR_LENGTH}}$`)
  );

export const humanIdentityTokenSchema = z
  .string()
  .regex(
    new RegExp(`^${HUMAN_IDENTITY_TOKEN_PREFIX}[A-Za-z0-9_-]{${HUMAN_TOKEN_SECRET_CHAR_LENGTH}}$`)
  );

export const identityCredentialIdSchema = opaqueIdentifierSchema.brand("IdentityCredentialId");
export type IdentityCredentialId = z.infer<typeof identityCredentialIdSchema>;

export const humanPrincipalMergeIdSchema = opaqueIdentifierSchema.brand("HumanPrincipalMergeId");
export type HumanPrincipalMergeId = z.infer<typeof humanPrincipalMergeIdSchema>;

export const humanIdentitySchemaVersion = "human-identity/v1" as const;
export const humanIdentitySchemaVersionSchema = z.literal(humanIdentitySchemaVersion);
export type HumanIdentitySchemaVersion = z.infer<typeof humanIdentitySchemaVersionSchema>;

export const projectInvitationTokenSchema = z
  .string()
  .regex(
    new RegExp(
      `^${PROJECT_INVITATION_TOKEN_PREFIX}[A-Za-z0-9_-]{${HUMAN_TOKEN_SECRET_CHAR_LENGTH}}$`
    )
  );

/**
 * One-time setup code plaintext. Distinct from device, invitation, Host enrollment,
 * Host credential, and operator bearer prefixes. Displayed at most once and redeemed
 * at most once for a single purpose.
 */
export const setupCodeTokenSchema = z
  .string()
  .regex(
    new RegExp(`^${SETUP_CODE_TOKEN_PREFIX}[A-Za-z0-9_-]{${HUMAN_TOKEN_SECRET_CHAR_LENGTH}}$`)
  );

export const projectMemberRoleSchema = z.enum(["owner", "member"]);
export type ProjectMemberRole = z.infer<typeof projectMemberRoleSchema>;

export const projectInvitationRoleSchema = z.literal("member");

export const projectInvitationTtlMsSchema = z
  .number()
  .int()
  .min(PROJECT_INVITATION_MIN_TTL_MS)
  .max(PROJECT_INVITATION_MAX_TTL_MS);

export const humanDeviceTtlMsSchema = z
  .number()
  .int()
  .min(HUMAN_DEVICE_MIN_TTL_MS)
  .max(HUMAN_DEVICE_MAX_TTL_MS);

export const setupCodeTtlMsSchema = z
  .number()
  .int()
  .min(SETUP_CODE_MIN_TTL_MS)
  .max(SETUP_CODE_MAX_TTL_MS);

export const actorRefSchema = z
  .object({
    kind: z.enum(["human", "local_admin", "system"]),
    id: opaqueIdentifierSchema,
    displayName: humanDisplayNameSchema.optional()
  })
  .strict();
export type ActorRef = z.infer<typeof actorRefSchema>;

export const taskWorkItemRefSchema = z
  .object({
    kind: z.literal("task"),
    canvasId: opaqueIdentifierSchema,
    taskId: opaqueIdentifierSchema
  })
  .strict();
export type TaskWorkItemRef = z.infer<typeof taskWorkItemRefSchema>;

export const blockWorkItemRefSchema = z
  .object({
    kind: z.literal("block"),
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema
  })
  .strict();
export type BlockWorkItemRef = z.infer<typeof blockWorkItemRefSchema>;

export const workItemRefSchema = z.discriminatedUnion("kind", [
  taskWorkItemRefSchema,
  blockWorkItemRefSchema
]);
export type WorkItemRef = z.infer<typeof workItemRefSchema>;

export const commentContentSha256Schema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/);

export { opaqueIdentifierSchema, blockRefSchema };
