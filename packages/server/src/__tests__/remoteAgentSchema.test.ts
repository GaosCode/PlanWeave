import { describe, expect, it } from "vitest";
import {
  agentAccessAuthoritySchema,
  authorizedRemoteAgentUseSchema,
  remoteAgentAccessModeSchema,
  remoteAgentAuthorizationErrorCodeSchema,
  remoteAgentEndpointAccessViewSchema,
  remoteAgentRecordSchema,
  remoteAgentWorkspaceGrantRecordSchema,
  runtimeAuthoritySchema
} from "../remoteAgent/schema.js";
import {
  RemoteAgentAuthorizationError,
  remoteAgentAuthorizationErrorCode
} from "../remoteAgent/errors.js";

const timestamp = "2026-08-03T08:00:00.000Z";

const remoteAgent = {
  endpointId: "aep_0123456789abcdef",
  hostId: "host-primary",
  profileId: "profile-main",
  agentId: "codex",
  ownerHumanPrincipalId: "owner-human-1",
  displayName: "Codex",
  accessMode: "unrestricted" as const,
  policyRevision: 1,
  ownershipRepairRequired: false,
  createdAt: timestamp,
  updatedAt: timestamp,
  revokedAt: null
};

const workspaceGrant = {
  endpointId: "aep_0123456789abcdef",
  workspaceId: "workspace-a",
  grantRevision: 1,
  grantedByHumanPrincipalId: "owner-human-1",
  createdAt: timestamp,
  updatedAt: timestamp,
  revokedAt: null
};

describe("remote agent domain schemas", () => {
  it("parses a valid Remote Agent record", () => {
    expect(remoteAgentRecordSchema.parse(remoteAgent)).toEqual(remoteAgent);
    expect(
      remoteAgentRecordSchema.parse({
        ...remoteAgent,
        accessMode: "workspace_restricted",
        revokedAt: timestamp
      })
    ).toMatchObject({ accessMode: "workspace_restricted", revokedAt: timestamp });
  });

  it("rejects a Remote Agent record without an owner", () => {
    expect(() =>
      remoteAgentRecordSchema.parse({ ...remoteAgent, ownerHumanPrincipalId: undefined })
    ).toThrow();
    expect(() =>
      remoteAgentRecordSchema.parse({ ...remoteAgent, ownerHumanPrincipalId: "" })
    ).toThrow();
    expect(() =>
      remoteAgentRecordSchema.parse({ ...remoteAgent, ownerHumanPrincipalId: null })
    ).toThrow();
  });

  it("parses a repair-required Remote Agent without an owner", () => {
    const repairRequired = {
      ...remoteAgent,
      ownerHumanPrincipalId: null,
      accessMode: "workspace_restricted" as const,
      ownershipRepairRequired: true
    };
    expect(remoteAgentRecordSchema.parse(repairRequired)).toEqual(repairRequired);
    expect(
      remoteAgentRecordSchema.parse({
        ...repairRequired,
        ownerHumanPrincipalId: "owner-human-1"
      })
    ).toMatchObject({
      ownerHumanPrincipalId: "owner-human-1",
      ownershipRepairRequired: true
    });
  });

  it("rejects unrestricted when owner is missing or ownership is repair-required", () => {
    expect(() =>
      remoteAgentRecordSchema.parse({
        ...remoteAgent,
        ownerHumanPrincipalId: null,
        accessMode: "unrestricted",
        ownershipRepairRequired: true
      })
    ).toThrow();
    expect(() =>
      remoteAgentRecordSchema.parse({
        ...remoteAgent,
        accessMode: "unrestricted",
        ownershipRepairRequired: true
      })
    ).toThrow();
  });

  it("rejects access_mode outside unrestricted | workspace_restricted", () => {
    expect(remoteAgentAccessModeSchema.options).toEqual(["unrestricted", "workspace_restricted"]);
    expect(() =>
      remoteAgentRecordSchema.parse({ ...remoteAgent, accessMode: "owner_only" })
    ).toThrow();
    expect(() => remoteAgentRecordSchema.parse({ ...remoteAgent, accessMode: "shared" })).toThrow();
  });

  it("rejects policy_revision below 1", () => {
    expect(() => remoteAgentRecordSchema.parse({ ...remoteAgent, policyRevision: 0 })).toThrow();
    expect(() => remoteAgentRecordSchema.parse({ ...remoteAgent, policyRevision: -1 })).toThrow();
    expect(() => remoteAgentRecordSchema.parse({ ...remoteAgent, policyRevision: 1.5 })).toThrow();
  });

  it("parses a valid Workspace Grant and rejects grant_revision below 1", () => {
    expect(remoteAgentWorkspaceGrantRecordSchema.parse(workspaceGrant)).toEqual(workspaceGrant);
    expect(() =>
      remoteAgentWorkspaceGrantRecordSchema.parse({ ...workspaceGrant, grantRevision: 0 })
    ).toThrow();
    expect(() =>
      remoteAgentWorkspaceGrantRecordSchema.parse({
        ...workspaceGrant,
        grantedByHumanPrincipalId: undefined
      })
    ).toThrow();
  });

  it("keeps RuntimeAuthority and AgentAccessAuthority discriminated unions strict", () => {
    expect(runtimeAuthoritySchema.parse({ kind: "owner_canvas" })).toEqual({
      kind: "owner_canvas"
    });
    expect(
      runtimeAuthoritySchema.parse({ kind: "workspace_canvas", workspaceId: "workspace-a" })
    ).toEqual({ kind: "workspace_canvas", workspaceId: "workspace-a" });
    expect(() =>
      runtimeAuthoritySchema.parse({ kind: "owner_canvas", workspaceId: "workspace-a" })
    ).toThrow();
    expect(() => runtimeAuthoritySchema.parse({ kind: "workspace_canvas" })).toThrow();
    expect(() => runtimeAuthoritySchema.parse({ kind: "fleet" })).toThrow();

    expect(
      agentAccessAuthoritySchema.parse({
        kind: "agent_owner",
        ownerHumanPrincipalId: "owner-human-1",
        policyRevision: 2
      })
    ).toEqual({
      kind: "agent_owner",
      ownerHumanPrincipalId: "owner-human-1",
      policyRevision: 2
    });
    expect(
      agentAccessAuthoritySchema.parse({
        kind: "workspace_grant",
        workspaceId: "workspace-a",
        grantRevision: 3,
        policyRevision: 2
      })
    ).toEqual({
      kind: "workspace_grant",
      workspaceId: "workspace-a",
      grantRevision: 3,
      policyRevision: 2
    });
    expect(() =>
      agentAccessAuthoritySchema.parse({
        kind: "agent_owner",
        ownerHumanPrincipalId: "owner-human-1",
        policyRevision: 0
      })
    ).toThrow();
    expect(() =>
      agentAccessAuthoritySchema.parse({
        kind: "workspace_grant",
        workspaceId: "workspace-a",
        grantRevision: 1,
        policyRevision: 0
      })
    ).toThrow();
    expect(() =>
      agentAccessAuthoritySchema.parse({
        kind: "workspace_grant",
        workspaceId: "workspace-a",
        grantRevision: 1
      })
    ).toThrow();
    expect(() =>
      agentAccessAuthoritySchema.parse({
        kind: "workspace_grant",
        workspaceId: "workspace-a",
        grantRevision: 1,
        policyRevision: 2,
        ownerHumanPrincipalId: "owner-human-1"
      })
    ).toThrow();
    expect(() => agentAccessAuthoritySchema.parse({ kind: "server_admin" })).toThrow();
  });

  it("parses AuthorizedRemoteAgentUse and the future catalog access view", () => {
    const authorized = {
      remoteAgent: {
        endpointId: remoteAgent.endpointId,
        hostId: remoteAgent.hostId,
        profileId: remoteAgent.profileId,
        agentId: remoteAgent.agentId
      },
      runtimeAuthority: { kind: "workspace_canvas" as const, workspaceId: "workspace-a" },
      agentAccessAuthority: {
        kind: "agent_owner" as const,
        ownerHumanPrincipalId: "owner-human-1",
        policyRevision: 1
      },
      resolvedAt: timestamp
    };
    expect(authorizedRemoteAgentUseSchema.parse(authorized)).toEqual(authorized);
    expect(() =>
      authorizedRemoteAgentUseSchema.parse({ ...authorized, controlPlane: "owner" })
    ).toThrow();
    expect(remoteAgentEndpointAccessViewSchema.parse({ basis: "agent_owner" })).toEqual({
      basis: "agent_owner"
    });
    expect(
      remoteAgentEndpointAccessViewSchema.parse({
        basis: "workspace_grant",
        workspaceId: "workspace-a"
      })
    ).toEqual({ basis: "workspace_grant", workspaceId: "workspace-a" });
  });

  it("owns exactly the planned authorization error codes", () => {
    expect([...remoteAgentAuthorizationErrorCodeSchema.options]).toEqual([
      "remote_agent_not_found",
      "remote_agent_revoked",
      "remote_agent_owner_required",
      "remote_agent_workspace_grant_missing",
      "remote_agent_workspace_scope_forbidden",
      "remote_agent_ownership_repair_required",
      "remote_agent_policy_revision_conflict",
      "remote_agent_grant_revision_conflict"
    ]);
    const error = new RemoteAgentAuthorizationError("remote_agent_workspace_grant_missing");
    expect(error).toBeInstanceOf(RemoteAgentAuthorizationError);
    expect(error.code).toBe("remote_agent_workspace_grant_missing");
    expect(remoteAgentAuthorizationErrorCode(error)).toBe("remote_agent_workspace_grant_missing");
    expect(
      remoteAgentAuthorizationErrorCode(new Error("agent_endpoint_unavailable"))
    ).toBeUndefined();
    expect(() => new RemoteAgentAuthorizationError("agent_endpoint_unknown" as never)).toThrow();
  });
});
