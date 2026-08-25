import { describe, expect, it } from "vitest";
import {
  AgentEndpointCatalog,
  endpointIdFor,
  type AgentEndpointCapacityPort,
  type AgentEndpointHostPort
} from "../agentEndpointCatalog.js";
import type { AgentHost } from "../hosts.js";

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

function catalogFixture(hostsInput: AgentHost[] = [readyHost()]) {
  const hosts = hostsInput;
  const hostPort: AgentEndpointHostPort = {
    listActiveHosts: (limit, offset) => hosts.slice(offset, offset + limit)
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
    })
  };
}

describe("Phase 5 catalog availability", () => {
  it("keeps endpointId stable and independent of workspace bindings", () => {
    const host = readyHost();
    const id = endpointIdFor({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex"
    });
    const state = catalogFixture([host]);
    expect(state.catalog.listVisibleFleet().items[0]?.endpointId).toBe(id);
    expect(state.catalog.listVisible("workspace-a").items[0]?.endpointId).toBe(id);
  });

  it("does not hide a multi-workspace mapping host from workspace listing", () => {
    const host = readyHost({
      readinessObservation: {
        workspaceMappings: [
          { workspaceId: "workspace-a", status: "ready" },
          { workspaceId: "workspace-b", status: "ready" }
        ],
        acpProfiles: readyHost().readinessObservation!.acpProfiles
      }
    });
    const state = catalogFixture([host]);
    expect(state.catalog.listVisible("workspace-a").items[0]?.endpointId).toBe(
      endpointIdFor({ hostId: host.id, profileId: "profile-main", agentId: "codex" })
    );
    expect(state.catalog.listVisible("workspace-b").items[0]?.endpointId).toBe(
      endpointIdFor({ hostId: host.id, profileId: "profile-main", agentId: "codex" })
    );
    expect(state.catalog.listVisibleFleet().items[0]?.endpointId).toBe(
      endpointIdFor({ hostId: host.id, profileId: "profile-main", agentId: "codex" })
    );
  });
});
