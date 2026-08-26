import { describe, expect, it } from "vitest";
import {
  agentEndpointErrorCodeSchema,
  agentEndpointUnavailableReasonSchema,
  assertRemoteAgentEndpointRedacted,
  remoteAgentAuthorizationErrorCodeSchema,
  remoteAgentEndpointAccessViewSchema,
  remoteAgentEndpointListSchema,
  remoteAgentEndpointSchema
} from "../agentEndpoint.js";

const endpoint = {
  schemaVersion: "agent-endpoint/v1",
  endpointId: "aep_0123456789abcdef",
  agentId: "codex",
  profileId: "default",
  displayName: "Codex",
  hostDisplayName: "Build Mac",
  status: "available",
  capabilities: ["acp.codex"]
} as const;

describe("agent endpoint protocol", () => {
  it("strictly parses a redacted endpoint and list response", () => {
    expect(remoteAgentEndpointSchema.parse(endpoint)).toEqual(endpoint);
    expect(
      remoteAgentEndpointListSchema.parse({
        schemaVersion: "agent-endpoint-list/v1",
        items: [endpoint]
      })
    ).toEqual({ schemaVersion: "agent-endpoint-list/v1", items: [endpoint] });
    expect(() => remoteAgentEndpointSchema.parse({ ...endpoint, hostId: "host-secret" })).toThrow();
  });

  it("requires a bounded reason only for unavailable endpoints", () => {
    expect([...agentEndpointUnavailableReasonSchema.options]).toEqual([
      "host_offline",
      "host_revoked",
      "host_credential_expired",
      "profile_missing",
      "profile_invalid",
      "at_capacity"
    ]);
    expect(() => remoteAgentEndpointSchema.parse({ ...endpoint, status: "unavailable" })).toThrow();
    expect(() =>
      remoteAgentEndpointSchema.parse({
        ...endpoint,
        unavailableReason: "host_offline"
      })
    ).toThrow();
    expect(
      remoteAgentEndpointSchema.parse({
        ...endpoint,
        status: "unavailable",
        unavailableReason: "at_capacity"
      })
    ).toMatchObject({ status: "unavailable", unavailableReason: "at_capacity" });
    for (const unavailableReason of [
      "workspace_mapping_missing",
      "workspace_mapping_invalid"
    ] as const) {
      expect(
        remoteAgentEndpointSchema.safeParse({
          ...endpoint,
          status: "unavailable",
          unavailableReason
        }).success
      ).toBe(false);
    }
  });

  it("has a dedicated redaction assertion for sensitive Host fields", () => {
    expect(() => assertRemoteAgentEndpointRedacted(endpoint)).not.toThrow();
    for (const sensitive of [
      "hostId",
      "command",
      "args",
      "env",
      "token",
      "path",
      "readinessObservation"
    ]) {
      expect(() =>
        assertRemoteAgentEndpointRedacted({ ...endpoint, [sensitive]: "secret" })
      ).toThrow("agent_endpoint_projection_not_redacted");
    }
  });

  it("keeps current wire endpoints free of access/basis fields", () => {
    expect(() =>
      remoteAgentEndpointSchema.parse({ ...endpoint, access: { basis: "agent_owner" } })
    ).toThrow();
    expect(() => remoteAgentEndpointSchema.parse({ ...endpoint, basis: "agent_owner" })).toThrow();
  });

  it("parses a strict future access view without changing current error bodies", () => {
    expect(remoteAgentEndpointAccessViewSchema.parse({ basis: "agent_owner" })).toEqual({
      basis: "agent_owner"
    });
    expect(
      remoteAgentEndpointAccessViewSchema.parse({
        basis: "workspace_grant",
        workspaceId: "workspace-a"
      })
    ).toEqual({ basis: "workspace_grant", workspaceId: "workspace-a" });
    expect(() =>
      remoteAgentEndpointAccessViewSchema.parse({
        basis: "agent_owner",
        workspaceId: "workspace-a"
      })
    ).toThrow();
    expect(() => remoteAgentEndpointAccessViewSchema.parse({ basis: "workspace_grant" })).toThrow();
    expect([...remoteAgentAuthorizationErrorCodeSchema.options]).toEqual([
      "remote_agent_not_found",
      "remote_agent_revoked",
      "remote_agent_owner_required",
      "remote_agent_workspace_grant_missing",
      "remote_agent_workspace_scope_forbidden",
      "remote_agent_ownership_repair_required",
      "remote_agent_access_snapshot_missing",
      "remote_agent_policy_revision_conflict",
      "remote_agent_grant_revision_conflict"
    ]);
    for (const code of remoteAgentAuthorizationErrorCodeSchema.options) {
      expect(agentEndpointErrorCodeSchema.safeParse(code).success).toBe(false);
    }
  });
});
