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

describe("Phase 0 catalog availability characterization", () => {
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

  it("keeps exclusive-bind catalog gap until Phase 5", () => {
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
    expect(state.catalog.listVisible("workspace-a").items).toEqual([]);
    expect(state.catalog.listVisible("workspace-b").items).toEqual([]);
    expect(state.catalog.listVisibleFleet().items[0]?.endpointId).toBe(
      endpointIdFor({ hostId: host.id, profileId: "profile-main", agentId: "codex" })
    );
  });
});
