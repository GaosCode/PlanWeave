import { z } from "zod";
import { artifactRefSchema } from "./artifacts.js";
import { capabilitiesSchema } from "./capabilities.js";
import { hostEnrollmentCodeSchema } from "./agentHostCredentials.js";
import { blockRefSchema } from "./blockRef.js";
import { opaqueIdentifierSchema } from "./identifiers.js";
import { hostReadinessObservationSchema } from "./hostReadiness.js";
import { hostCredentialPolicySchema } from "./credentialLifecycle.js";
import { dispatchIdSchema, executionAttemptIdSchema } from "./executionIdentity.js";
import { SOURCE_IDENTITY_MAX_LENGTH } from "./limits.js";

/** Bounded operator credential accepted by Server and held only by Desktop main. */
export const operatorTokenSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

const timestampSchema = z.iso.datetime();

/** Shared pagination contract for bounded operator collection endpoints. */
export const operatorPageQuerySchema = z
  .object({
    /** Optional scope selector; Server verifies it against authenticated authority. */
    workspaceId: opaqueIdentifierSchema.optional(),
    cursor: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50)
  })
  .strict();

const remoteAgentAccessModeSchema = z.enum(["unrestricted", "workspace_restricted"]);

export const operatorEnrollmentGrantRequestSchema = z
  .object({
    /** Target scope selector; Server validates it against the authenticated operator. */
    workspaceId: opaqueIdentifierSchema.optional(),
    expiresAt: timestampSchema,
    credentialPolicy: hostCredentialPolicySchema,
    /** Explicit verified Human Principal owner. Never inferred from operatorId. */
    ownerHumanPrincipalId: opaqueIdentifierSchema.optional(),
    accessMode: remoteAgentAccessModeSchema.optional(),
    /** When true, also create a Workspace Grant for `workspaceId` after readiness sync. */
    createWorkspaceGrant: z.boolean().optional()
  })
  .strict()
  .superRefine((value, context) => {
    const hasOwner = value.ownerHumanPrincipalId !== undefined;
    if (!hasOwner && value.accessMode !== undefined) {
      context.addIssue({
        code: "custom",
        message: "access_mode_requires_owner"
      });
    }
    if (value.createWorkspaceGrant === true) {
      if (value.workspaceId === undefined) {
        context.addIssue({
          code: "custom",
          message: "create_workspace_grant_requires_workspace"
        });
      }
      if (!hasOwner) {
        context.addIssue({
          code: "custom",
          message: "create_workspace_grant_requires_owner"
        });
      }
    }
  });

export const operatorEnrollmentGrantResponseSchema = z
  .object({
    enrollmentCode: hostEnrollmentCodeSchema,
    /** Optional legacy collaboration workspace scope; server-scoped fleet grants omit it. */
    workspaceId: opaqueIdentifierSchema.optional(),
    expiresAt: timestampSchema,
    credentialExpiresAt: timestampSchema,
    credentialPolicy: hostCredentialPolicySchema
  })
  .strict();

export const operatorHostAvailabilityReasonSchema = z.enum([
  "revoked",
  "offline",
  "readiness_not_reported",
  "acp_profile_missing",
  "acp_profile_invalid",
  "capability_mismatch"
]);

export const operatorHostAvailabilitySchema = z
  .object({
    status: z.enum(["available", "unavailable"]),
    reason: operatorHostAvailabilityReasonSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "available" && value.reason !== null) ||
      (value.status === "unavailable" && value.reason === null)
    ) {
      context.addIssue({ code: "custom", message: "operator_host_availability_reason_mismatch" });
    }
  });

export const operatorHostViewSchema = z
  .object({
    id: opaqueIdentifierSchema,
    /** Present for legacy workspace-bound Hosts; omitted for server-scoped fleet Hosts. */
    workspaceId: opaqueIdentifierSchema.optional(),
    displayName: z.string().min(1).max(128),
    capabilities: capabilitiesSchema,
    capacity: z.number().int().min(1).max(128),
    online: z.boolean(),
    lastSeenAt: timestampSchema.optional(),
    revokedAt: timestampSchema.optional(),
    credentialExpiresAt: timestampSchema.optional(),
    credentialPolicy: hostCredentialPolicySchema.optional(),
    credentialRenewalRequestedAt: timestampSchema.optional(),
    readinessObservation: hostReadinessObservationSchema.optional(),
    availability: operatorHostAvailabilitySchema
  })
  .strict();

export const operatorHostPageSchema = z
  .object({
    items: z.array(operatorHostViewSchema).max(100),
    nextCursor: z.number().int().positive().nullable()
  })
  .strict();

/** Revoke returns the same redacted Host projection as GET /hosts/:hostId. */
export const operatorHostRevokeResponseSchema = operatorHostViewSchema;
export const operatorHostRenewalRequestSchema = z.object({}).strict();
export const operatorHostRenewalResponseSchema = operatorHostViewSchema;

export const OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE =
  "application/vnd.planweave.owner-terminal-result.v1+octet-stream";
export const OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER =
  "x-planweave-owner-terminal-result-metadata";

const operatorOwnerTerminalResultSourceRevisionSchema = z
  .string()
  .min(1)
  .max(SOURCE_IDENTITY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/** Private Owner-canvas writeback metadata paired with the terminal report byte stream. */
export const operatorOwnerTerminalResultMetadataSchema = z
  .object({
    operationId: opaqueIdentifierSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema,
    controlPlane: z.literal("owner"),
    sourceRevision: operatorOwnerTerminalResultSourceRevisionSchema,
    graphFingerprint: z.string().regex(/^pkg-[a-f0-9]{64}$/),
    dispatchId: dispatchIdSchema,
    executionAttemptId: executionAttemptIdSchema,
    reportArtifactRef: artifactRefSchema
  })
  .strict();

export type OperatorEnrollmentGrantRequest = z.infer<typeof operatorEnrollmentGrantRequestSchema>;
export type OperatorEnrollmentGrantResponse = z.infer<typeof operatorEnrollmentGrantResponseSchema>;
export type OperatorHostView = z.infer<typeof operatorHostViewSchema>;
export type OperatorHostAvailability = z.infer<typeof operatorHostAvailabilitySchema>;
export type OperatorHostAvailabilityReason = z.infer<typeof operatorHostAvailabilityReasonSchema>;
export type OperatorHostPage = z.infer<typeof operatorHostPageSchema>;
export type OperatorPageQuery = z.infer<typeof operatorPageQuerySchema>;
export type OperatorHostRenewalRequest = z.infer<typeof operatorHostRenewalRequestSchema>;
export type OperatorOwnerTerminalResultMetadata = z.infer<
  typeof operatorOwnerTerminalResultMetadataSchema
>;
export type OperatorOwnerTerminalResultPayload = {
  metadata: OperatorOwnerTerminalResultMetadata;
  reportBytes: Uint8Array;
};
