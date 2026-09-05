import { z } from "zod";
import {
  deploymentEndpointSchema,
  isDeploymentServerOrigin,
  isLoopbackDeploymentHostname,
  isPrivateDeploymentHostname,
  type DeploymentEndpoint
} from "@planweave-ai/agent-host-protocol/browser";
export {
  deploymentEndpointSchema,
  deploymentTlsTrustSchema,
  deploymentTopologySchema,
  type DeploymentEndpoint,
  type DeploymentTlsTrust,
  type DeploymentTopology
} from "@planweave-ai/agent-host-protocol/browser";
import {
  COLLABORATION_JSON_BODY_MAX_BYTES,
  COLLABORATION_REQUEST_TIMEOUT_MS,
  HUMAN_MAX_MEMBERS_LISTED_PER_PAGE,
  HUMAN_OBSERVER_MAX_PAYLOAD_BYTES,
  WORKSPACE_PICKER_MAX_ITEMS_PER_PAGE
} from "./limits.js";
import {
  deviceSessionIdSchema,
  humanDisplayNameSchema,
  humanMembershipIdSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  opaqueIdentifierSchema,
  workspaceIdSchema,
  workspaceIdentitySchemaVersionSchema,
  workspaceNameSchema,
  workspaceRoleSchema,
  workspaceSetupSchemaVersionSchema,
  timestampSchema
} from "./primitives.js";

/**
 * HTTP(S) origin only: protocol + host [+ port], path must be `/`.
 * Arbitrary absolute URLs with paths, query strings, or non-http schemes are rejected.
 */
export function isCollaborationServerOrigin(value: string): boolean {
  return isDeploymentServerOrigin(value);
}

export function isLoopbackHostname(hostname: string): boolean {
  return isLoopbackDeploymentHostname(hostname);
}

/** Literal private-network hosts accepted for explicitly enabled LAN HTTP. */
export function isPrivateNetworkHostname(hostname: string): boolean {
  return isPrivateDeploymentHostname(hostname);
}

/** Shared origin validator for Desktop profiles and setup handoff envelopes. */
export const collaborationServerOriginSchema = z
  .string()
  .url()
  .refine(isCollaborationServerOrigin, "serverBaseUrl must be an http(s) origin without a path");

export function refineCollaborationTransportPolicy(
  value: { serverBaseUrl: string; allowInsecureTransport: boolean },
  ctx: z.RefinementCtx
): void {
  const url = new URL(value.serverBaseUrl);
  if (url.protocol !== "https:" && !value.allowInsecureTransport) {
    ctx.addIssue({
      code: "custom",
      message: "HTTPS is required unless allowInsecureTransport is true",
      path: ["serverBaseUrl"]
    });
  }
  if (value.allowInsecureTransport && url.protocol === "http:") {
    if (!isPrivateNetworkHostname(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        message: "Insecure HTTP is only allowed for loopback or private-network hosts",
        path: ["serverBaseUrl"]
      });
    }
  }
}

function refineProfileEndpoint(
  value: {
    serverBaseUrl: string;
    allowInsecureTransport: boolean;
    endpoint: DeploymentEndpoint;
  },
  context: z.RefinementCtx
): void {
  if (value.serverBaseUrl !== value.endpoint.serverOrigin) {
    context.addIssue({
      code: "custom",
      path: ["endpoint"],
      message: "profile_endpoint_origin_mismatch"
    });
  }
  const insecure =
    value.endpoint.topology === "loopback_http" || value.endpoint.topology === "lan_http";
  if (value.allowInsecureTransport !== insecure) {
    context.addIssue({
      code: "custom",
      path: ["endpoint"],
      message: "profile_endpoint_transport_mismatch"
    });
  }
}

/**
 * Validated Desktop connection profile for a logical project/server pair.
 * Does not store credentials — credential is injected via a separate port.
 */
export const legacyCollaborationConnectionProfileSchema = z
  .object({
    profileId: opaqueIdentifierSchema,
    displayName: z.string().trim().min(1).max(128),
    serverBaseUrl: collaborationServerOriginSchema,
    projectId: humanProjectIdSchema,
    allowInsecureTransport: z.boolean().default(false)
  })
  .strict()
  .superRefine(refineCollaborationTransportPolicy);
export type LegacyCollaborationConnectionProfile = z.infer<
  typeof legacyCollaborationConnectionProfileSchema
>;

export const collaborationConnectionProfileSchema = z
  .object({
    profileId: opaqueIdentifierSchema,
    displayName: z.string().trim().min(1).max(128),
    /** Base URL origin only (no path). HTTPS required unless allowInsecureTransport. */
    serverBaseUrl: collaborationServerOriginSchema,
    projectId: humanProjectIdSchema,
    allowInsecureTransport: z.boolean().default(false),
    endpoint: deploymentEndpointSchema
  })
  .strict()
  .superRefine(refineCollaborationTransportPolicy)
  .superRefine(refineProfileEndpoint);
export type CollaborationConnectionProfile = z.infer<typeof collaborationConnectionProfileSchema>;

/**
 * Workspace-first connection profile. Unlike the legacy project profile above,
 * this profile cannot be created without an opaque Workspace authority. It never
 * carries a device/operator/Host secret; callers inject credentials through a
 * separate secure transport port.
 */
export const workspaceConnectionProfileSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    profileId: opaqueIdentifierSchema,
    displayName: workspaceNameSchema,
    serverBaseUrl: collaborationServerOriginSchema,
    workspaceId: workspaceIdSchema,
    allowInsecureTransport: z.boolean()
  })
  .strict()
  .superRefine(refineCollaborationTransportPolicy);
export type WorkspaceConnectionProfile = z.infer<typeof workspaceConnectionProfileSchema>;

export function parseWorkspaceConnectionProfile(input: unknown): WorkspaceConnectionProfile {
  return workspaceConnectionProfileSchema.parse(input);
}

/**
 * Redacted Workspace picker row for Desktop renderer. No credentials, digests,
 * projectRoot, commands, or arbitrary URLs.
 */
export const workspacePickerItemSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    displayName: workspaceNameSchema,
    role: workspaceRoleSchema.nullable(),
    archivedAt: timestampSchema.nullable(),
    membershipActive: z.boolean()
  })
  .strict();
export type WorkspacePickerItem = z.infer<typeof workspacePickerItemSchema>;

export const workspacePickerPageSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    items: z.array(workspacePickerItemSchema).max(WORKSPACE_PICKER_MAX_ITEMS_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type WorkspacePickerPage = z.infer<typeof workspacePickerPageSchema>;

/** Current human + this device, readable with a Workspace device session. */
export const workspaceConnectionSelfViewSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    membershipId: humanMembershipIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    role: workspaceRoleSchema,
    deviceSessionId: deviceSessionIdSchema
  })
  .strict();
export type WorkspaceConnectionSelfView = z.infer<typeof workspaceConnectionSelfViewSchema>;

export const workspaceConnectionSelfUpdateRequestSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    displayName: humanDisplayNameSchema
  })
  .strict();
export type WorkspaceConnectionSelfUpdateRequest = z.infer<
  typeof workspaceConnectionSelfUpdateRequestSchema
>;

export const workspaceConnectionDeviceViewSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    deviceSessionId: deviceSessionIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    issuedAt: timestampSchema,
    lastUsedAt: timestampSchema.nullable(),
    isCurrentDevice: z.boolean()
  })
  .strict();
export type WorkspaceConnectionDeviceView = z.infer<typeof workspaceConnectionDeviceViewSchema>;

export const workspaceConnectionMemberViewSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    membershipId: humanMembershipIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    role: workspaceRoleSchema,
    devices: z.array(workspaceConnectionDeviceViewSchema).max(HUMAN_MAX_MEMBERS_LISTED_PER_PAGE)
  })
  .strict();
export type WorkspaceConnectionMemberView = z.infer<typeof workspaceConnectionMemberViewSchema>;

export const workspaceConnectionMembersPageSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    items: z.array(workspaceConnectionMemberViewSchema).max(HUMAN_MAX_MEMBERS_LISTED_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type WorkspaceConnectionMembersPage = z.infer<typeof workspaceConnectionMembersPageSchema>;

/**
 * Desktop "single Server/Workspace connection" status. Exactly one active remote
 * connection is modeled; local-only projects remain disconnected until the user
 * explicitly connects. Secrets never appear here.
 */
export const activeWorkspaceConnectionStatusSchema = z.enum([
  "local_only",
  "connecting",
  "connected",
  "reconnecting",
  "error",
  "disconnected"
]);
export type ActiveWorkspaceConnectionStatus = z.infer<typeof activeWorkspaceConnectionStatusSchema>;

export const activeWorkspaceConnectionErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(512).optional(),
    retryable: z.boolean()
  })
  .strict();
export type ActiveWorkspaceConnectionError = z.infer<typeof activeWorkspaceConnectionErrorSchema>;

export const activeWorkspaceConnectionViewSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    status: activeWorkspaceConnectionStatusSchema,
    profile: workspaceConnectionProfileSchema.nullable(),
    workspaceId: workspaceIdSchema.nullable(),
    workspaceDisplayName: workspaceNameSchema.nullable(),
    connectedAt: timestampSchema.nullable(),
    error: activeWorkspaceConnectionErrorSchema.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "local_only") {
      if (value.profile !== null || value.workspaceId !== null) {
        ctx.addIssue({
          code: "custom",
          message: "local_only_connection_must_not_bind_remote_profile"
        });
      }
      return;
    }
    if (value.status === "connected" || value.status === "reconnecting") {
      if (value.profile === null || value.workspaceId === null) {
        ctx.addIssue({
          code: "custom",
          message: "active_connection_requires_profile_and_workspace"
        });
      } else if (value.profile.workspaceId !== value.workspaceId) {
        ctx.addIssue({
          code: "custom",
          message: "connection_workspace_mismatch"
        });
      }
    }
    if (value.status === "error" && value.error === null) {
      ctx.addIssue({ code: "custom", message: "error_connection_requires_error" });
    }
  });
export type ActiveWorkspaceConnectionView = z.infer<typeof activeWorkspaceConnectionViewSchema>;

export const collaborationClientLimitsSchema = z
  .object({
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(300_000)
      .default(COLLABORATION_REQUEST_TIMEOUT_MS),
    jsonBodyMaxBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1_024 * 1_024)
      .default(COLLABORATION_JSON_BODY_MAX_BYTES),
    observerMaxPayloadBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1_024 * 1_024)
      .default(HUMAN_OBSERVER_MAX_PAYLOAD_BYTES),
    reconnectInitialDelayMs: z.number().int().positive().max(60_000).default(250),
    reconnectMaxDelayMs: z.number().int().positive().max(300_000).default(30_000)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.reconnectInitialDelayMs > value.reconnectMaxDelayMs) {
      ctx.addIssue({
        code: "custom",
        message: "reconnectInitialDelayMs must be <= reconnectMaxDelayMs",
        path: ["reconnectInitialDelayMs"]
      });
    }
  });
export type CollaborationClientLimits = z.infer<typeof collaborationClientLimitsSchema>;

export function parseCollaborationConnectionProfile(
  input: unknown
): CollaborationConnectionProfile {
  return collaborationConnectionProfileSchema.parse(input);
}

export function parseCollaborationClientLimits(
  input: Partial<CollaborationClientLimits> | undefined = {}
): CollaborationClientLimits {
  return collaborationClientLimitsSchema.parse(input);
}
