import {
  capabilitiesSchema,
  hostAcpProfileObservationSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import { workspaceIdSchema } from "./primitives.js";

export const agentEndpointUnavailableReasonSchema = z.enum([
  "host_offline",
  "host_revoked",
  "host_credential_expired",
  "host_capability_missing",
  "profile_missing",
  "profile_invalid",
  "at_capacity"
]);

const agentProfileDescriptorSchema = hostAcpProfileObservationSchema.pick({
  profileId: true,
  agentId: true,
  displayName: true,
  capabilities: true
});

const agentEndpointBaseSchema = agentProfileDescriptorSchema.extend({
  schemaVersion: z.literal("agent-endpoint/v1"),
  endpointId: opaqueIdentifierSchema,
  hostDisplayName: hostAcpProfileObservationSchema.shape.displayName
});

export const availableRemoteAgentEndpointSchema = agentEndpointBaseSchema.extend({
  status: z.literal("available")
});

const unavailableAgentEndpointSchema = agentEndpointBaseSchema.extend({
  status: z.literal("unavailable"),
  unavailableReason: agentEndpointUnavailableReasonSchema
});

/** Strict, redacted human-visible projection of one exact Host ACP profile. */
export const remoteAgentEndpointSchema = z.discriminatedUnion("status", [
  availableRemoteAgentEndpointSchema,
  unavailableAgentEndpointSchema
]);

export const remoteAgentEndpointListSchema = z
  .object({
    schemaVersion: z.literal("agent-endpoint-list/v1"),
    items: z.array(remoteAgentEndpointSchema).max(12_800)
  })
  .strict();

export const agentEndpointErrorCodeSchema = z.enum([
  "agent_endpoint_unauthenticated",
  "agent_endpoint_forbidden",
  "agent_endpoint_request_invalid",
  "agent_endpoint_unknown",
  "agent_endpoint_unavailable",
  "agent_endpoint_incompatible",
  "agent_endpoint_request_failed"
]);

export const agentEndpointErrorResponseSchema = z
  .object({ error: agentEndpointErrorCodeSchema })
  .strict();

/**
 * Authorization failures for Remote Agent use. Separate from
 * `agentEndpointErrorCodeSchema` so current HTTP error bodies stay valid.
 */
export const remoteAgentAuthorizationErrorCodeSchema = z.enum([
  "remote_agent_not_found",
  "remote_agent_revoked",
  "remote_agent_owner_required",
  "remote_agent_workspace_grant_missing",
  "remote_agent_workspace_scope_forbidden",
  "remote_agent_owner_canvas_forbidden",
  "remote_agent_ownership_repair_required",
  "remote_agent_access_snapshot_missing",
  "remote_agent_policy_revision_conflict",
  "remote_agent_grant_revision_conflict"
]);

export const remoteAgentAccessBasisSchema = z.enum(["agent_owner", "workspace_grant"]);

/** Future catalog access projection. Not a required field on `remoteAgentEndpointSchema`. */
export const remoteAgentEndpointAccessViewSchema = z.discriminatedUnion("basis", [
  z.object({ basis: z.literal("agent_owner") }).strict(),
  z
    .object({
      basis: z.literal("workspace_grant"),
      workspaceId: workspaceIdSchema
    })
    .strict()
]);

const forbiddenEndpointKeys = new Set([
  "hostid",
  "host_id",
  "command",
  "args",
  "env",
  "environment",
  "token",
  "path",
  "readiness",
  "readinessobservation",
  "readiness_json",
  "credential",
  "credentialexpiresat"
]);

/** Assert both the strict wire shape and the absence of Host-local sensitive fields. */
export function assertRemoteAgentEndpointRedacted(
  input: unknown
): asserts input is RemoteAgentEndpoint {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("agent_endpoint_projection_invalid");
  }
  for (const key of Object.keys(input)) {
    if (forbiddenEndpointKeys.has(key.toLowerCase())) {
      throw new Error("agent_endpoint_projection_not_redacted");
    }
  }
  remoteAgentEndpointSchema.parse(input);
}

export type AgentEndpointUnavailableReason = z.infer<typeof agentEndpointUnavailableReasonSchema>;
export type RemoteAgentEndpoint = z.infer<typeof remoteAgentEndpointSchema>;
export type RemoteAgentEndpointList = z.infer<typeof remoteAgentEndpointListSchema>;
export type AgentEndpointErrorCode = z.infer<typeof agentEndpointErrorCodeSchema>;
export type AgentEndpointErrorResponse = z.infer<typeof agentEndpointErrorResponseSchema>;
export type RemoteAgentAuthorizationErrorCode = z.infer<
  typeof remoteAgentAuthorizationErrorCodeSchema
>;
export type RemoteAgentAccessBasis = z.infer<typeof remoteAgentAccessBasisSchema>;
export type RemoteAgentEndpointAccessView = z.infer<typeof remoteAgentEndpointAccessViewSchema>;

export { capabilitiesSchema as agentEndpointCapabilitiesSchema };
