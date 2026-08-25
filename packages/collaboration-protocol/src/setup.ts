import { z } from "zod";
import {
  collaborationServerOriginSchema,
  isPrivateNetworkHostname,
  workspaceConnectionProfileSchema
} from "./connection.js";
import {
  SETUP_CODE_DEFAULT_TTL_MS,
  SETUP_CODE_MAX_LISTED_PER_PAGE,
  SETUP_CODE_REASON_MAX_LENGTH,
  HOST_BOOTSTRAP_HANDOFF_REASON_MAX_LENGTH
} from "./limits.js";
import {
  agentHostIdSchema,
  credentialSha256Schema,
  deviceSessionIdSchema,
  hostEnrollmentIdSchema,
  opaqueIdentifierSchema,
  humanDeviceLabelSchema,
  humanDeviceTokenSchema,
  humanDisplayNameSchema,
  humanMembershipIdSchema,
  humanPrincipalIdSchema,
  operatorCredentialTokenSchema,
  operatorDisplayNameSchema,
  operatorIdSchema,
  operatorSessionIdSchema,
  setupCodeIdSchema,
  setupCodeLifecycleStateSchema,
  setupCodeRevocationIdSchema,
  setupCodeTokenSchema,
  setupCodeTtlMsSchema,
  setupCredentialPurposeSchema,
  timestampSchema,
  workspaceIdSchema,
  workspaceNameSchema,
  workspaceRoleSchema,
  workspaceSetupSchemaVersionSchema
} from "./primitives.js";

const nullableTimestampSchema = timestampSchema.nullable();

const hostCapabilitySchema = z.string().trim().min(1).max(128);
const hostCapabilitiesSchema = z
  .array(hostCapabilitySchema)
  .max(128)
  .superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", message: "duplicate_host_capability" });
    }
  });

/** Exported trust-boundary ownership for Server / Desktop / Agent Host consumers. */
export const setupContractOwnership = {
  server: {
    creates: ["setup_code_grant", "setup_code_revocation"],
    issuesOnce: ["setup_code_plaintext"],
    redeemsOnce: ["setup_code_grant"],
    authenticates: ["device_session", "operator_session", "agent_host"]
  },
  desktop: {
    consumes: [
      "setup_code_issue_response",
      "setup_code_redeem_response",
      "workspace_picker_page",
      "active_workspace_connection_view",
      "host_bootstrap_handoff_view"
    ],
    storesSecrets: ["device_token", "operator_token"],
    neverForwardsToRenderer: ["setup_code", "device_token", "operator_token", "host_credential"]
  },
  agentHost: {
    consumes: ["host_bootstrap_enrollment_secret", "agent_host_credential_binding"],
    neverAccepts: ["device_token", "operator_token", "project_root", "command"]
  }
} as const;

/**
 * Server-durable setup code grant. Only digests are stored; plaintext is never
 * accepted on this schema. projectRoot, long-lived secrets, commands, and mixed
 * credential material are structurally excluded.
 */
export const setupCodeGrantSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    setupCodeId: setupCodeIdSchema,
    workspaceId: workspaceIdSchema,
    purpose: setupCredentialPurposeSchema,
    codeSha256: credentialSha256Schema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    displayedAt: nullableTimestampSchema,
    redeemedAt: nullableTimestampSchema,
    revokedAt: nullableTimestampSchema,
    redemptionSubjectId: z.string().trim().min(1).max(128).nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
      ctx.addIssue({ code: "custom", message: "setup_code_expiry_order_invalid" });
    }
    const redeemed = value.redeemedAt !== null;
    if (redeemed !== (value.redemptionSubjectId !== null)) {
      ctx.addIssue({ code: "custom", message: "setup_code_redemption_marker_mismatch" });
    }
    if (value.displayedAt !== null && Date.parse(value.displayedAt) < Date.parse(value.issuedAt)) {
      ctx.addIssue({ code: "custom", message: "setup_code_display_before_issue" });
    }
    if (value.redeemedAt !== null && value.displayedAt === null) {
      ctx.addIssue({ code: "custom", message: "setup_code_redeem_before_display" });
    }
  });
export type SetupCodeGrant = z.infer<typeof setupCodeGrantSchema>;

/** Redaction-safe grant projection for Desktop / audit UIs. */
export const setupCodeGrantViewSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    setupCodeId: setupCodeIdSchema,
    workspaceId: workspaceIdSchema,
    purpose: setupCredentialPurposeSchema,
    state: setupCodeLifecycleStateSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    displayedAt: nullableTimestampSchema,
    redeemedAt: nullableTimestampSchema,
    revokedAt: nullableTimestampSchema
  })
  .strict();
export type SetupCodeGrantView = z.infer<typeof setupCodeGrantViewSchema>;

export const setupCodeIssueRequestSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    purpose: setupCredentialPurposeSchema,
    ttlMs: setupCodeTtlMsSchema.optional()
  })
  .strict();
export type SetupCodeIssueRequest = z.infer<typeof setupCodeIssueRequestSchema>;

/**
 * Issue response returns plaintext exactly once. Consumers must display it once
 * and must not persist it in renderer state, logs, URLs, or evidence.
 */
export const setupCodeIssueResponseSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    grant: setupCodeGrantViewSchema,
    setupCode: setupCodeTokenSchema,
    displayOnce: z.literal(true)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.grant.state !== "displayed" && value.grant.state !== "issued") {
      ctx.addIssue({
        code: "custom",
        message: "setup_code_issue_response_state_invalid",
        path: ["grant", "state"]
      });
    }
  });
export type SetupCodeIssueResponse = z.infer<typeof setupCodeIssueResponseSchema>;

const redeemBase = {
  schemaVersion: workspaceSetupSchemaVersionSchema,
  setupCode: setupCodeTokenSchema
} as const;

/** Device-session redeem: human Desktop onboarding only. */
export const setupCodeRedeemDeviceRequestSchema = z
  .object({
    ...redeemBase,
    purpose: z.literal("device_session"),
    displayName: humanDisplayNameSchema,
    deviceLabel: humanDeviceLabelSchema.optional(),
    /** Reuse a Server-global Human Principal proven by an existing device token. */
    existingDeviceToken: humanDeviceTokenSchema.optional()
  })
  .strict();
export type SetupCodeRedeemDeviceRequest = z.infer<typeof setupCodeRedeemDeviceRequestSchema>;

/** Operator-session redeem: control-plane enrollment only. */
export const setupCodeRedeemOperatorRequestSchema = z
  .object({
    ...redeemBase,
    purpose: z.literal("operator_session"),
    displayName: operatorDisplayNameSchema
  })
  .strict();
export type SetupCodeRedeemOperatorRequest = z.infer<typeof setupCodeRedeemOperatorRequestSchema>;

/**
 * Host enrollment redeem: Agent Host presents a Host-only credential it generated.
 * Human device and operator tokens are rejected by construction.
 */
export const setupCodeRedeemHostRequestSchema = z
  .object({
    ...redeemBase,
    purpose: z.literal("host_enrollment"),
    displayName: workspaceNameSchema,
    capabilities: hostCapabilitiesSchema,
    capacity: z.number().int().min(1).max(128),
    enrollmentAttemptId: opaqueIdentifierSchema,
    hostCredentialToken: z.string().regex(/^pw_host_[A-Za-z0-9_-]{43}$/)
  })
  .strict();
export type SetupCodeRedeemHostRequest = z.infer<typeof setupCodeRedeemHostRequestSchema>;

export const setupCodeRedeemRequestSchema = z.discriminatedUnion("purpose", [
  setupCodeRedeemDeviceRequestSchema,
  setupCodeRedeemOperatorRequestSchema,
  setupCodeRedeemHostRequestSchema
]);
export type SetupCodeRedeemRequest = z.infer<typeof setupCodeRedeemRequestSchema>;

const connectedWorkspaceFields = {
  schemaVersion: workspaceSetupSchemaVersionSchema,
  workspaceId: workspaceIdSchema,
  workspaceDisplayName: workspaceNameSchema,
  connectionProfile: workspaceConnectionProfileSchema
} as const;

export const setupCodeRedeemDeviceResponseSchema = z
  .object({
    ...connectedWorkspaceFields,
    purpose: z.literal("device_session"),
    humanPrincipalId: humanPrincipalIdSchema,
    membershipId: humanMembershipIdSchema,
    role: workspaceRoleSchema,
    deviceSessionId: deviceSessionIdSchema,
    deviceToken: humanDeviceTokenSchema,
    deviceExpiresAt: nullableTimestampSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.connectionProfile.workspaceId !== value.workspaceId) {
      ctx.addIssue({ code: "custom", message: "redeem_connection_workspace_mismatch" });
    }
  });
export type SetupCodeRedeemDeviceResponse = z.infer<typeof setupCodeRedeemDeviceResponseSchema>;

export const setupCodeRedeemOperatorResponseSchema = z
  .object({
    ...connectedWorkspaceFields,
    purpose: z.literal("operator_session"),
    operatorId: operatorIdSchema,
    operatorSessionId: operatorSessionIdSchema,
    operatorToken: operatorCredentialTokenSchema,
    sessionExpiresAt: timestampSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.connectionProfile.workspaceId !== value.workspaceId) {
      ctx.addIssue({ code: "custom", message: "redeem_connection_workspace_mismatch" });
    }
  });
export type SetupCodeRedeemOperatorResponse = z.infer<typeof setupCodeRedeemOperatorResponseSchema>;

export const setupCodeRedeemHostResponseSchema = z
  .object({
    ...connectedWorkspaceFields,
    purpose: z.literal("host_enrollment"),
    enrollmentAttemptId: opaqueIdentifierSchema,
    enrollmentId: hostEnrollmentIdSchema,
    hostId: agentHostIdSchema,
    hostCredentialExpiresAt: timestampSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.connectionProfile.workspaceId !== value.workspaceId) {
      ctx.addIssue({ code: "custom", message: "redeem_connection_workspace_mismatch" });
    }
  });
export type SetupCodeRedeemHostResponse = z.infer<typeof setupCodeRedeemHostResponseSchema>;

export const setupCodeRedeemResponseSchema = z.discriminatedUnion("purpose", [
  setupCodeRedeemDeviceResponseSchema,
  setupCodeRedeemOperatorResponseSchema,
  setupCodeRedeemHostResponseSchema
]);
export type SetupCodeRedeemResponse = z.infer<typeof setupCodeRedeemResponseSchema>;

export const setupCodeRevokeRequestSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    setupCodeId: setupCodeIdSchema,
    reason: z.string().trim().min(1).max(SETUP_CODE_REASON_MAX_LENGTH)
  })
  .strict();
export type SetupCodeRevokeRequest = z.infer<typeof setupCodeRevokeRequestSchema>;

export const setupCodeRevocationSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    revocationId: setupCodeRevocationIdSchema,
    setupCodeId: setupCodeIdSchema,
    workspaceId: workspaceIdSchema,
    purpose: setupCredentialPurposeSchema,
    revokedAt: timestampSchema,
    reason: z.string().trim().min(1).max(SETUP_CODE_REASON_MAX_LENGTH)
  })
  .strict();
export type SetupCodeRevocation = z.infer<typeof setupCodeRevocationSchema>;

export const setupCodeListQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(SETUP_CODE_MAX_LISTED_PER_PAGE).default(50),
    openOnly: z.boolean().optional()
  })
  .strict();
export type SetupCodeListQuery = z.infer<typeof setupCodeListQuerySchema>;

export const setupCodeGrantPageSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    items: z.array(setupCodeGrantViewSchema).max(SETUP_CODE_MAX_LISTED_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type SetupCodeGrantPage = z.infer<typeof setupCodeGrantPageSchema>;

/**
 * Renderer-safe Host bootstrap/enrollment handoff. Never carries enrollment codes,
 * Host credentials, device tokens, operator tokens, projectRoot, or shell commands.
 */
export const hostBootstrapHandoffStateSchema = z.enum([
  "idle",
  "pending",
  "ready",
  "failed",
  "expired",
  "revoked"
]);
export type HostBootstrapHandoffState = z.infer<typeof hostBootstrapHandoffStateSchema>;

export const hostBootstrapHandoffViewSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    workspaceDisplayName: workspaceNameSchema,
    serverBaseUrl: collaborationServerOriginSchema,
    allowInsecureTransport: z.boolean(),
    state: hostBootstrapHandoffStateSchema,
    hostId: agentHostIdSchema.nullable(),
    enrollmentId: hostEnrollmentIdSchema.nullable(),
    reason: z.string().trim().min(1).max(HOST_BOOTSTRAP_HANDOFF_REASON_MAX_LENGTH).nullable(),
    updatedAt: timestampSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    const url = new URL(value.serverBaseUrl);
    if (url.protocol !== "https:" && !value.allowInsecureTransport) {
      ctx.addIssue({
        code: "custom",
        message: "HTTPS is required unless allowInsecureTransport is true",
        path: ["serverBaseUrl"]
      });
    }
    if (
      value.allowInsecureTransport &&
      url.protocol === "http:" &&
      !isPrivateNetworkHostname(url.hostname)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Insecure HTTP is only allowed for loopback or private-network hosts",
        path: ["serverBaseUrl"]
      });
    }
    if (value.state === "ready" && (value.hostId === null || value.enrollmentId === null)) {
      ctx.addIssue({ code: "custom", message: "ready_handoff_requires_host_and_enrollment" });
    }
    if (
      (value.state === "failed" || value.state === "expired" || value.state === "revoked") &&
      value.reason === null
    ) {
      ctx.addIssue({ code: "custom", message: "terminal_handoff_requires_reason" });
    }
  });
export type HostBootstrapHandoffView = z.infer<typeof hostBootstrapHandoffViewSchema>;

/**
 * Main-process / Host-only enrollment secret envelope. Not for renderer, logs,
 * generic IPC, URLs, or evidence. Carries either a setup code (preferred) or a
 * legacy Host enrollment code — never both and never mixed human/operator secrets.
 */
export const hostBootstrapEnrollmentSecretSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    serverBaseUrl: collaborationServerOriginSchema,
    allowInsecureTransport: z.boolean(),
    kind: z.enum(["setup_code", "host_enrollment_code"]),
    setupCode: setupCodeTokenSchema.optional(),
    hostEnrollmentCode: z
      .string()
      .regex(/^pw_enroll_[A-Za-z0-9_-]{43}$/)
      .optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const url = new URL(value.serverBaseUrl);
    if (url.protocol !== "https:" && !value.allowInsecureTransport) {
      ctx.addIssue({
        code: "custom",
        message: "HTTPS is required unless allowInsecureTransport is true",
        path: ["serverBaseUrl"]
      });
    }
    if (
      value.allowInsecureTransport &&
      url.protocol === "http:" &&
      !isPrivateNetworkHostname(url.hostname)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Insecure HTTP is only allowed for loopback or private-network hosts",
        path: ["serverBaseUrl"]
      });
    }
    if (value.kind === "setup_code") {
      if (!value.setupCode) {
        ctx.addIssue({
          code: "custom",
          message: "setup_code_secret_required",
          path: ["setupCode"]
        });
      }
      if (value.hostEnrollmentCode !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "mixed_host_enrollment_secret",
          path: ["hostEnrollmentCode"]
        });
      }
    }
    if (value.kind === "host_enrollment_code") {
      if (!value.hostEnrollmentCode) {
        ctx.addIssue({
          code: "custom",
          message: "host_enrollment_code_required",
          path: ["hostEnrollmentCode"]
        });
      }
      if (value.setupCode !== undefined) {
        ctx.addIssue({ code: "custom", message: "mixed_setup_code_secret", path: ["setupCode"] });
      }
    }
  });
export type HostBootstrapEnrollmentSecret = z.infer<typeof hostBootstrapEnrollmentSecretSchema>;

export type SetupCodeUsability =
  | { usable: true; state: "issued" | "displayed" }
  | {
      usable: false;
      state:
        | "redeemed"
        | "expired"
        | "revoked"
        | "workspace_mismatch"
        | "purpose_mismatch"
        | "not_displayed";
    };

/**
 * Pure grant usability check used by Server redeem paths and contract fixtures.
 * Replay (already redeemed), expiry, revocation, cross-Workspace, and wrong
 * purpose all fail closed.
 */
export function evaluateSetupCodeUsability(input: {
  grant: SetupCodeGrant;
  workspaceId: string;
  purpose: z.infer<typeof setupCredentialPurposeSchema>;
  now: Date;
  requireDisplayed?: boolean;
}): SetupCodeUsability {
  if (input.grant.workspaceId !== input.workspaceId) {
    return { usable: false, state: "workspace_mismatch" };
  }
  if (input.grant.purpose !== input.purpose) {
    return { usable: false, state: "purpose_mismatch" };
  }
  if (input.grant.revokedAt !== null) return { usable: false, state: "revoked" };
  if (input.grant.redeemedAt !== null) return { usable: false, state: "redeemed" };
  if (Date.parse(input.grant.expiresAt) <= input.now.getTime()) {
    return { usable: false, state: "expired" };
  }
  if (input.requireDisplayed === true && input.grant.displayedAt === null) {
    return { usable: false, state: "not_displayed" };
  }
  if (input.grant.displayedAt !== null) return { usable: true, state: "displayed" };
  return { usable: true, state: "issued" };
}

export function deriveSetupCodeLifecycleState(input: {
  grant: SetupCodeGrant;
  now: Date;
}): z.infer<typeof setupCodeLifecycleStateSchema> {
  if (input.grant.revokedAt !== null) return "revoked";
  if (input.grant.redeemedAt !== null) return "redeemed";
  if (Date.parse(input.grant.expiresAt) <= input.now.getTime()) return "expired";
  if (input.grant.displayedAt !== null) return "displayed";
  return "issued";
}

/** Ensures setup views never leak digests, tokens, paths, or commands. */
export function assertSetupViewRedacted(value: unknown): void {
  const forbiddenKey =
    /^(?:credential(?:Sha256|Hash|Token)|credential[_-](?:sha256|hash|token)|token(?:Sha256|Hash|Token)?|token[_-](?:sha256|hash|token)|secret|password|setupCode|setup[_-]?code|codeSha256|code[_-]?sha256|enrollment(?:Code|Hash)|enrollment[_-](?:code|hash)|hostCredentialToken|host[_-]?credential[_-]?token|deviceToken|device[_-]?token|operatorToken|operator[_-]?token|projectRoot|project[_-]?root|executable|command|args|environment|env)$/i;
  const forbiddenValue =
    /\b(?:pw_setup_|pw_hdev_|pw_inv_|pw_enroll_|pw_host_|pw_operator_)[A-Za-z0-9_-]{10,}\b/;
  const visit = (current: unknown): boolean => {
    if (typeof current === "string") return forbiddenValue.test(current);
    if (Array.isArray(current)) return current.some(visit);
    if (!current || typeof current !== "object") return false;
    return Object.entries(current).some(([key, nested]) => {
      if (forbiddenKey.test(key)) return true;
      return visit(nested);
    });
  };
  if (visit(value)) throw new Error("setup_view_not_redacted");
}

/**
 * Rejects redeem attempts that confuse credential types (e.g. redeeming a
 * host_enrollment grant with a device_session request body).
 */
export function assertSetupRedeemPurposeMatch(
  grant: Pick<SetupCodeGrant, "purpose">,
  request: Pick<SetupCodeRedeemRequest, "purpose">
): void {
  if (grant.purpose !== request.purpose) {
    throw new Error("setup_code_purpose_mismatch");
  }
}

export function defaultSetupCodeTtlMs(): number {
  return SETUP_CODE_DEFAULT_TTL_MS;
}
