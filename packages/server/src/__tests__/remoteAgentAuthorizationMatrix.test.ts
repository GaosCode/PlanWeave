import { describe, expect, it } from "vitest";
import {
  AgentEndpointCatalog,
  AgentEndpointCatalogError,
  endpointIdFor,
  type AgentEndpointCapacityPort,
  type AgentEndpointHostPort
} from "../agentEndpointCatalog.js";
import type { AgentHost } from "../hosts.js";
import {
  authorizedRemoteAgentUseSchema,
  type RemoteAgentAuthorizationErrorCode
} from "../remoteAgent/schema.js";
import { RemoteAgentAuthorizationError } from "../remoteAgent/errors.js";

const now = new Date("2026-08-03T08:00:00.000Z");

function readyHost(overrides: Partial<AgentHost> = {}): AgentHost {
  return {
    id: "host-primary",
    displayName: "Build Mac",
    capabilities: ["acp.codex", "host-only"],
    capacity: 2,
    lastSeenAt: now.toISOString(),
    lastAcknowledgedSequence: 0,
    credentialExpiresAt: "2026-08-04T08:00:00.000Z",
    readinessObservation: {
      workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
      acpProfiles: [
        {
          profileId: "profile-main",
          agentId: "codex",
          displayName: "Codex",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    },
    ...overrides
  };
}

function catalogFixture(
  hostsInput: AgentHost[] = [readyHost()],
  exclusiveByWorkspace?: Readonly<Record<string, AgentHost[]>>
) {
  const hosts = hostsInput;
  let exclusive = exclusiveByWorkspace;
  const hostPort: AgentEndpointHostPort = {
    listActiveHosts: (limit, offset) => hosts.slice(offset, offset + limit),
    listExclusivelyBoundToWorkspace: (workspaceId) =>
      exclusive === undefined ? hosts : (exclusive[workspaceId] ?? [])
  };
  const capacityPort: AgentEndpointCapacityPort = {
    activeCountsForHosts: (hostIds) => new Map(hostIds.map((hostId) => [hostId, 0]))
  };
  return {
    catalog: new AgentEndpointCatalog({
      hosts: hostPort,
      capacities: capacityPort,
      hostOfflineAfterMs: 60_000,
      clock: () => now
    }),
    setExclusiveBindings(next: Readonly<Record<string, AgentHost[]>>) {
      exclusive = next;
    }
  };
}

function expectAuthorizationCode(run: () => unknown, code: RemoteAgentAuthorizationErrorCode) {
  expect(run).toThrow(RemoteAgentAuthorizationError);
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteAgentAuthorizationError);
    expect((error as RemoteAgentAuthorizationError).code).toBe(code);
    expect([
      "agent_endpoint_unavailable",
      "agent_endpoint_incompatible",
      "agent_endpoint_unknown"
    ]).not.toContain((error as RemoteAgentAuthorizationError).code);
    return;
  }
  expect.unreachable("expected RemoteAgentAuthorizationError");
}

describe("Phase 0 future remote agent authorization matrix", () => {
  it.fails("1. owner + unrestricted Agent + owner canvas allows with agent_owner authority", () => {
    // resolveForRun always requires workspaceId; unbound fleet + owner controlPlane is
    // the closest live analog of owner_canvas. Phase 2/3 must split locators.
    const host = readyHost({
      readinessObservation: {
        workspaceMappings: [],
        acpProfiles: readyHost().readinessObservation!.acpProfiles
      }
    });
    const state = catalogFixture([host], {});
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    const resolved = state.catalog.resolveForRun(
      endpoint.endpointId,
      "workspace-a",
      ["acp.codex"],
      "owner"
    );
    expect(authorizedRemoteAgentUseSchema.parse(resolved)).toMatchObject({
      remoteAgent: {
        endpointId: endpoint.endpointId,
        hostId: "host-primary",
        profileId: "profile-main",
        agentId: "codex"
      },
      runtimeAuthority: { kind: "owner_canvas" },
      agentAccessAuthority: { kind: "agent_owner", policyRevision: expect.any(Number) }
    });
  });

  it.fails("2. owner + unrestricted Agent + workspace canvas allows without a grant", () => {
    // Exclusive workspace binding is the closest live analog of targeting a workspace
    // canvas; unrestricted owner still must not require a grant.
    const host = readyHost();
    const state = catalogFixture([host], { "workspace-a": [host] });
    const endpoint = state.catalog.listVisible("workspace-a").items[0]!;
    const resolved = state.catalog.resolveForRun(
      endpoint.endpointId,
      "workspace-a",
      ["acp.codex"],
      "owner"
    );
    expect(authorizedRemoteAgentUseSchema.parse(resolved)).toMatchObject({
      runtimeAuthority: { kind: "workspace_canvas", workspaceId: "workspace-a" },
      agentAccessAuthority: { kind: "agent_owner", policyRevision: expect.any(Number) }
    });
  });

  it.fails("3. owner + workspace_restricted Agent + workspace without grant rejects scope forbidden", () => {
    // Intended: access_mode=workspace_restricted, owner principal, grant exists only on B.
    const host = readyHost();
    const state = catalogFixture([host], { "workspace-b": [host] });
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    expectAuthorizationCode(
      () => state.catalog.resolveForRun(endpoint.endpointId, "workspace-a", ["acp.codex"], "owner"),
      "remote_agent_workspace_scope_forbidden"
    );
  });

  it.fails("3b. owner + workspace_restricted Agent + valid grant on current workspace allows", () => {
    // Grant is only the workspace_restricted scope check; the owner still receives
    // agent_owner (plan 3.6 / 6.3), not workspace_grant.
    const host = readyHost();
    const state = catalogFixture([host], { "workspace-a": [host] });
    const endpoint = state.catalog.listVisible("workspace-a").items[0]!;
    const resolved = state.catalog.resolveForRun(
      endpoint.endpointId,
      "workspace-a",
      ["acp.codex"],
      "owner"
    );
    expect(authorizedRemoteAgentUseSchema.parse(resolved)).toMatchObject({
      runtimeAuthority: { kind: "workspace_canvas", workspaceId: "workspace-a" },
      agentAccessAuthority: {
        kind: "agent_owner",
        policyRevision: expect.any(Number)
      }
    });
  });

  it.fails("3c. owner + workspace_restricted Agent + owner canvas rejects scope forbidden", () => {
    // resolveForRun always takes a workspaceId, so owner_canvas is not a live locator.
    // Unbound fleet + owner controlPlane is the closest analog of local/owner canvas.
    const host = readyHost({
      readinessObservation: {
        workspaceMappings: [],
        acpProfiles: readyHost().readinessObservation!.acpProfiles
      }
    });
    const state = catalogFixture([host], {});
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    expectAuthorizationCode(
      () => state.catalog.resolveForRun(endpoint.endpointId, "workspace-a", ["acp.codex"], "owner"),
      "remote_agent_workspace_scope_forbidden"
    );
  });

  it.fails("4. workspace member + valid grant on the current workspace allows with workspace_grant authority", () => {
    const host = readyHost();
    const state = catalogFixture([host], { "workspace-a": [host] });
    const endpoint = state.catalog.listVisible("workspace-a").items[0]!;
    const resolved = state.catalog.resolveForRun(
      endpoint.endpointId,
      "workspace-a",
      ["acp.codex"],
      "collaboration"
    );
    expect(authorizedRemoteAgentUseSchema.parse(resolved)).toMatchObject({
      runtimeAuthority: { kind: "workspace_canvas", workspaceId: "workspace-a" },
      agentAccessAuthority: {
        kind: "workspace_grant",
        workspaceId: "workspace-a",
        grantRevision: expect.any(Number),
        policyRevision: expect.any(Number)
      }
    });
  });

  it.fails("5. workspace B member calling an Agent granted only to A is rejected even with endpointId", () => {
    const host = readyHost();
    const state = catalogFixture([host], { "workspace-a": [host] });
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    expectAuthorizationCode(
      () =>
        state.catalog.resolveForRun(
          endpoint.endpointId,
          "workspace-b",
          ["acp.codex"],
          "collaboration"
        ),
      "remote_agent_workspace_grant_missing"
    );
  });

  it.fails("6. known endpointId without grant cannot bypass via fleet fallback", () => {
    const host = readyHost({
      readinessObservation: {
        workspaceMappings: [],
        acpProfiles: readyHost().readinessObservation!.acpProfiles
      }
    });
    const state = catalogFixture([host], {});
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    expect(state.catalog.listVisible("workspace-a").items).toEqual([]);
    expectAuthorizationCode(
      () =>
        state.catalog.resolveForRun(
          endpoint.endpointId,
          "workspace-a",
          ["acp.codex"],
          "collaboration"
        ),
      "remote_agent_workspace_grant_missing"
    );
  });

  it.fails("7. Agent granted to A and B allows both workspaces", () => {
    // listExclusivelyBoundToWorkspace uses HAVING COUNT(*)=1, so a host bound to
    // both A and B is excluded from every workspace catalog. Dual grants cannot be
    // represented by exclusive binding; {} is that current exclusion, not dual grants.
    const host = readyHost({
      readinessObservation: {
        workspaceMappings: [
          { workspaceId: "workspace-a", status: "ready" },
          { workspaceId: "workspace-b", status: "ready" }
        ],
        acpProfiles: readyHost().readinessObservation!.acpProfiles
      }
    });
    const state = catalogFixture([host], {});
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    expect(state.catalog.listVisible("workspace-a").items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ endpointId: endpoint.endpointId, status: "available" })
      ])
    );
    expect(state.catalog.listVisible("workspace-b").items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ endpointId: endpoint.endpointId, status: "available" })
      ])
    );
    expect(
      authorizedRemoteAgentUseSchema.parse(
        state.catalog.resolveForRun(
          endpoint.endpointId,
          "workspace-a",
          ["acp.codex"],
          "collaboration"
        )
      )
    ).toMatchObject({
      agentAccessAuthority: {
        kind: "workspace_grant",
        workspaceId: "workspace-a",
        grantRevision: expect.any(Number),
        policyRevision: expect.any(Number)
      }
    });
    expect(
      authorizedRemoteAgentUseSchema.parse(
        state.catalog.resolveForRun(
          endpoint.endpointId,
          "workspace-b",
          ["acp.codex"],
          "collaboration"
        )
      )
    ).toMatchObject({
      agentAccessAuthority: {
        kind: "workspace_grant",
        workspaceId: "workspace-b",
        grantRevision: expect.any(Number),
        policyRevision: expect.any(Number)
      }
    });
  });

  it.fails("8. after grant revoke, new dispatch on A rejects and endpointId stays stable", () => {
    const host = readyHost();
    const state = catalogFixture([host], { "workspace-a": [host] });
    const endpointId = endpointIdFor({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex"
    });
    expect(state.catalog.listVisibleFleet().items[0]?.endpointId).toBe(endpointId);
    state.setExclusiveBindings({});
    expectAuthorizationCode(
      () => state.catalog.resolveForRun(endpointId, "workspace-a", ["acp.codex"], "collaboration"),
      "remote_agent_workspace_grant_missing"
    );
    expect(endpointIdFor({ hostId: host.id, profileId: "profile-main", agentId: "codex" })).toBe(
      endpointId
    );
  });

  it.fails("9. authorization failures stay distinct from offline and incompatible", () => {
    const host = readyHost({
      readinessObservation: {
        workspaceMappings: [],
        acpProfiles: readyHost().readinessObservation!.acpProfiles
      }
    });
    const state = catalogFixture([host], {});
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    expectAuthorizationCode(
      () =>
        state.catalog.resolveForRun(
          endpoint.endpointId,
          "workspace-a",
          ["acp.codex"],
          "collaboration"
        ),
      "remote_agent_workspace_grant_missing"
    );
    expect(() =>
      state.catalog.resolveForRun(endpoint.endpointId, "workspace-a", ["host-only"], "owner")
    ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_incompatible"));
  });
});
