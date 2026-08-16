import { describe, expect, it } from "vitest";
import {
  AgentEndpointCatalog,
  AgentEndpointCatalogError,
  endpointIdFor,
  legacyEndpointIdFor,
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

function activeHosts(hosts: AgentHost[]): AgentHost[] {
  return hosts.filter((host) => {
    if (host.revokedAt !== undefined) return false;
    const credentialExpiry =
      host.credentialExpiresAt === undefined ? undefined : Date.parse(host.credentialExpiresAt);
    if (
      credentialExpiry !== undefined &&
      (!Number.isFinite(credentialExpiry) || credentialExpiry <= now.getTime())
    ) {
      return false;
    }
    return true;
  });
}

function fixture(hostsInput: AgentHost[] = [readyHost()]) {
  let hosts = hostsInput;
  let counts = new Map<string, number>();
  const hostPageCalls: Array<{ limit: number; offset: number }> = [];
  const capacityHostIdCalls: string[][] = [];
  const hostPort: AgentEndpointHostPort = {
    listActiveHosts: (limit, offset) => {
      hostPageCalls.push({ limit, offset });
      return activeHosts(hosts).slice(offset, offset + limit);
    },
    listExclusivelyBoundToWorkspace: () => hosts
  };
  const capacityPort: AgentEndpointCapacityPort = {
    activeCountsForHosts: (hostIds) => {
      capacityHostIdCalls.push([...hostIds]);
      return new Map(hostIds.map((hostId) => [hostId, counts.get(hostId) ?? 0]));
    }
  };
  const catalog = new AgentEndpointCatalog({
    hosts: hostPort,
    capacities: capacityPort,
    hostOfflineAfterMs: 60_000,
    clock: () => now
  });
  return {
    catalog,
    hostPageCalls,
    capacityHostIdCalls,
    setHosts(next: AgentHost[]) {
      hosts = next;
    },
    setActive(hostId: string, count: number) {
      counts = new Map(counts).set(hostId, count);
    }
  };
}

function fleetEndpointFor(host: AgentHost = readyHost()) {
  return fixture([host]).catalog.listVisibleFleet().items[0];
}

function workspaceEndpointFor(host: AgentHost = readyHost(), workspaceId = "workspace-a") {
  return fixture([host]).catalog.listVisible(workspaceId).items[0];
}

describe("AgentEndpointCatalog", () => {
  it("B1: lists both Hosts in the fleet and derives ids without workspace", () => {
    const first = readyHost({
      id: "host-alpha",
      displayName: "Alpha",
      readinessObservation: {
        workspaceMappings: [],
        acpProfiles: [
          {
            profileId: "profile-pi",
            agentId: "pi",
            displayName: "Pi",
            status: "ready",
            capabilities: ["acp.codex"]
          }
        ]
      }
    });
    const second = readyHost({
      id: "host-beta",
      displayName: "Beta",
      readinessObservation: {
        workspaceMappings: [],
        acpProfiles: [
          {
            profileId: "profile-pi",
            agentId: "pi",
            displayName: "Pi",
            status: "ready",
            capabilities: ["acp.codex"]
          }
        ]
      }
    });
    const state = fixture([first, second]);
    const fleet = state.catalog.listVisibleFleet().items;
    expect(fleet).toHaveLength(2);
    expect(fleet.every((item) => item.agentId === "pi" && item.status === "available")).toBe(true);
    expect(new Set(fleet.map((item) => item.endpointId)).size).toBe(2);
    // Preserve Host addition order from listActiveHosts (not endpointId / displayName sort).
    expect(fleet.map((item) => item.hostDisplayName)).toEqual(["Alpha", "Beta"]);
    expect(fleet.map((item) => item.endpointId)).toEqual([
      endpointIdFor({ hostId: "host-alpha", profileId: "profile-pi", agentId: "pi" }),
      endpointIdFor({ hostId: "host-beta", profileId: "profile-pi", agentId: "pi" })
    ]);
    const singleHostState = fixture([readyHost()]);
    const workspaceA = singleHostState.catalog.listVisible("workspace-a").items[0]!;
    const workspaceB = singleHostState.catalog.listVisible("workspace-b").items[0]!;
    expect(workspaceA.endpointId).toBe(workspaceB.endpointId);
    expect(workspaceA.endpointId).toBe(
      endpointIdFor({ hostId: "host-primary", profileId: "profile-main", agentId: "codex" })
    );
  });

  it("enumerates and resolves active Hosts beyond the first repository page", () => {
    const hosts = Array.from({ length: 105 }, (_, index) =>
      readyHost({
        id: `host-${String(index + 1).padStart(3, "0")}`,
        displayName: `Host ${String(index + 1).padStart(3, "0")}`
      })
    );
    const state = fixture(hosts);

    const endpoints = state.catalog.listVisibleFleet().items;
    expect(endpoints).toHaveLength(105);
    expect(state.hostPageCalls).toEqual([
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 }
    ]);
    const endpointAfterFirstPage = endpoints[100]!;
    expect(endpointAfterFirstPage.hostDisplayName).toBe("Host 101");
    expect(
      state.catalog.resolveForRun(
        endpointAfterFirstPage.endpointId,
        "workspace-a",
        ["acp.codex"],
        "owner"
      )
    ).toMatchObject({ hostId: "host-101" });
  });

  it("fails closed when the active Host fleet exceeds the bounded snapshot", () => {
    let capacityCalls = 0;
    const catalog = new AgentEndpointCatalog({
      hosts: {
        listActiveHosts: (limit, offset) =>
          Array.from({ length: Math.min(limit, 12_801 - offset) }, (_, index) =>
            readyHost({ id: `host-${offset + index}` })
          ),
        listExclusivelyBoundToWorkspace: () => []
      },
      capacities: {
        activeCountsForHosts: () => {
          capacityCalls += 1;
          return new Map();
        }
      },
      hostOfflineAfterMs: 60_000,
      clock: () => now
    });

    expect(() => catalog.listVisibleFleet()).toThrowError("agent_endpoint_host_limit_exceeded");
    expect(capacityCalls).toBe(0);
  });

  it("fails closed before returning more endpoints than the wire list permits", () => {
    const profiles = Array.from({ length: 128 }, (_, index) => ({
      profileId: `profile-${index}`,
      agentId: `agent-${index}`,
      displayName: `Agent ${index}`,
      status: "ready" as const,
      capabilities: ["acp.codex"]
    }));
    const hosts = Array.from({ length: 101 }, (_, index) =>
      readyHost({
        id: `host-${index}`,
        readinessObservation: {
          workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
          acpProfiles: profiles
        }
      })
    );

    expect(() => fixture(hosts).catalog.listVisibleFleet()).toThrowError(
      "agent_endpoint_snapshot_limit_exceeded"
    );
  });

  it("B2: resolves legacy workspace-scoped endpoint ids", () => {
    const state = fixture();
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    const legacyId = legacyEndpointIdFor({
      workspaceId: "workspace-a",
      hostId: "host-primary",
      profileId: "profile-main",
      agentId: "codex"
    });
    expect(legacyId).not.toBe(endpoint.endpointId);
    expect(
      state.catalog.resolveForRun(legacyId, "workspace-a", ["acp.codex"], "collaboration")
    ).toMatchObject({ hostId: "host-primary", profileId: "profile-main", agentId: "codex" });
  });

  it("B3: projects offline Host state as unavailable in the fleet list", () => {
    expect(fleetEndpointFor(readyHost({ lastSeenAt: "2026-08-03T07:00:00.000Z" }))).toMatchObject({
      status: "unavailable",
      unavailableReason: "host_offline"
    });
  });

  it("keeps IDs stable across presentation and availability changes", () => {
    const original = fleetEndpointFor();
    const changed = fleetEndpointFor(
      readyHost({
        displayName: "Renamed Host",
        capacity: 8,
        lastSeenAt: "2026-08-03T07:00:00.000Z",
        readinessObservation: {
          workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
          acpProfiles: [
            {
              profileId: "profile-main",
              agentId: "codex",
              displayName: "Renamed Agent",
              status: "ready",
              capabilities: ["acp.codex"]
            }
          ]
        }
      })
    );
    expect(changed?.endpointId).toBe(original?.endpointId);
    expect(changed).toMatchObject({ status: "unavailable", unavailableReason: "host_offline" });
  });

  it("isolates IDs by Host, profile, and agent identity", () => {
    const base = fleetEndpointFor()?.endpointId;
    const variants = [
      fleetEndpointFor(readyHost({ id: "host-other" }))?.endpointId,
      fleetEndpointFor(
        readyHost({
          readinessObservation: {
            workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
            acpProfiles: [
              {
                profileId: "profile-other",
                agentId: "codex",
                displayName: "Codex",
                status: "ready",
                capabilities: ["acp.codex"]
              }
            ]
          }
        })
      )?.endpointId,
      fleetEndpointFor(
        readyHost({
          readinessObservation: {
            workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
            acpProfiles: [
              {
                profileId: "profile-main",
                agentId: "other-agent",
                displayName: "Other",
                status: "ready",
                capabilities: ["acp.codex"]
              }
            ]
          }
        })
      )?.endpointId
    ];
    expect(new Set([base, ...variants]).size).toBe(4);
  });

  it("lists Hosts without workspace mapping in the fleet catalog", () => {
    const host = readyHost({
      readinessObservation: {
        workspaceMappings: [],
        acpProfiles: readyHost().readinessObservation!.acpProfiles
      }
    });
    expect(fleetEndpointFor(host)).toMatchObject({ status: "available" });
    expect(workspaceEndpointFor(host)).toMatchObject({
      status: "unavailable",
      unavailableReason: "workspace_mapping_missing"
    });
  });

  it("rejects resolveForRun when a workspace-bound host has a missing workspace mapping", () => {
    const host = readyHost({
      readinessObservation: {
        workspaceMappings: [],
        acpProfiles: readyHost().readinessObservation!.acpProfiles
      }
    });
    const state = fixture([host]);
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    expect(state.catalog.listVisible("workspace-a").items[0]).toMatchObject({
      status: "unavailable",
      unavailableReason: "workspace_mapping_missing"
    });
    expect(() =>
      state.catalog.resolveForRun(
        endpoint.endpointId,
        "workspace-a",
        ["acp.codex"],
        "collaboration"
      )
    ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_unavailable"));
  });

  it("keeps fleet rules for resolveForRun when the host is not workspace-bound", () => {
    const host = readyHost({
      readinessObservation: {
        workspaceMappings: [],
        acpProfiles: readyHost().readinessObservation!.acpProfiles
      }
    });
    const hostPort: AgentEndpointHostPort = {
      listActiveHosts: (limit, offset) => activeHosts([host]).slice(offset, offset + limit),
      listExclusivelyBoundToWorkspace: () => []
    };
    const catalog = new AgentEndpointCatalog({
      hosts: hostPort,
      capacities: { activeCountsForHosts: () => new Map() },
      hostOfflineAfterMs: 60_000,
      clock: () => now
    });
    const endpoint = catalog.listVisibleFleet().items[0]!;
    expect(
      catalog.resolveForRun(endpoint.endpointId, "workspace-a", ["acp.codex"], "collaboration")
    ).toMatchObject({ hostId: "host-primary", profileId: "profile-main", agentId: "codex" });
  });

  it.each([
    ["revoked", { revokedAt: "2026-08-03T07:59:00.000Z" }],
    ["expired", { credentialExpiresAt: now.toISOString() }]
  ] as const)("omits %s Hosts from the visible executor catalog", (_name, overrides) => {
    expect(fleetEndpointFor(readyHost(overrides))).toBeUndefined();
  });

  it.each([
    ["missing", "workspace_mapping_missing"],
    ["invalid", "workspace_mapping_invalid"]
  ] as const)("projects a %s workspace mapping for legacy listVisible", (status, reason) => {
    const host = readyHost();
    host.readinessObservation = {
      workspaceMappings: [{ workspaceId: "workspace-a", status }],
      acpProfiles: host.readinessObservation!.acpProfiles
    };
    expect(workspaceEndpointFor(host)).toMatchObject({
      status: "unavailable",
      unavailableReason: reason
    });
  });

  it("treats a profile capability outside the Host capability set as invalid", () => {
    const host = readyHost();
    host.readinessObservation!.acpProfiles[0]!.capabilities = ["profile-only"];
    expect(fleetEndpointFor(host)).toMatchObject({
      status: "unavailable",
      unavailableReason: "profile_invalid"
    });
  });

  it.each([
    ["missing", "profile_missing"],
    ["invalid", "profile_invalid"]
  ] as const)("projects a %s exact profile", (status, reason) => {
    const host = readyHost();
    host.readinessObservation!.acpProfiles[0]!.status = status;
    expect(fleetEndpointFor(host)).toMatchObject({
      status: "unavailable",
      unavailableReason: reason
    });
  });

  it("keeps Owner Fleet endpoints available when collaboration Host capacity is occupied", () => {
    const state = fixture();
    const before = state.catalog.listVisibleFleet().items[0]!;
    state.setActive("host-primary", 2);
    const after = state.catalog.listVisibleFleet().items[0]!;
    expect(after.endpointId).toBe(before.endpointId);
    expect(after).toMatchObject({ status: "available" });
    expect(state.catalog.listVisible("workspace-a").items[0]).toMatchObject({
      status: "unavailable",
      unavailableReason: "at_capacity"
    });
    expect(
      state.catalog.resolveForRun(after.endpointId, "workspace-a", ["acp.codex"], "owner")
    ).toMatchObject({ hostId: "host-primary" });
    expect(() =>
      state.catalog.resolveForRun(after.endpointId, "workspace-a", ["acp.codex"], "collaboration")
    ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_unavailable"));
  });

  it("loads capacity once for a multi-endpoint workspace catalog snapshot", () => {
    const hosts = [
      readyHost({ id: "host-alpha", displayName: "Alpha" }),
      readyHost({ id: "host-beta", displayName: "Beta" })
    ];
    const state = fixture(hosts);
    state.setActive("host-beta", 2);

    expect(state.catalog.listVisible("workspace-a").items).toMatchObject([
      { hostDisplayName: "Alpha", status: "available" },
      { hostDisplayName: "Beta", status: "unavailable", unavailableReason: "at_capacity" }
    ]);
    expect(state.capacityHostIdCalls).toEqual([["host-alpha", "host-beta"]]);
  });

  it("resolves from a fresh snapshot and checks Host and profile capabilities separately", () => {
    const state = fixture();
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    expect(
      state.catalog.resolveForRun(
        endpoint.endpointId,
        "workspace-a",
        ["acp.codex"],
        "collaboration"
      )
    ).toMatchObject({ hostId: "host-primary", profileId: "profile-main", agentId: "codex" });
    expect(() =>
      state.catalog.resolveForRun(
        endpoint.endpointId,
        "workspace-a",
        ["host-only"],
        "collaboration"
      )
    ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_incompatible"));
  });

  it("revalidates an exact reserved Endpoint while discounting its own capacity lease", () => {
    const state = fixture();
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    state.setActive("host-primary", 2);
    expect(
      state.catalog.resolveForReservedRun(
        endpoint.endpointId,
        "workspace-a",
        ["acp.codex"],
        "host-primary",
        "collaboration"
      )
    ).toMatchObject({ endpointId: endpoint.endpointId, hostId: "host-primary" });
    expect(() =>
      state.catalog.resolveForReservedRun(
        endpoint.endpointId,
        "workspace-a",
        ["acp.codex"],
        "host-secondary",
        "collaboration"
      )
    ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_unknown"));
  });

  it("fails a stale endpoint instead of rerouting to another compatible Host", () => {
    const first = readyHost();
    const second = readyHost({ id: "host-secondary", displayName: "Second Host" });
    const state = fixture([first, second]);
    const endpoint = state.catalog
      .listVisibleFleet()
      .items.find((item) => item.hostDisplayName === "Build Mac")!;
    state.setHosts([{ ...first, lastSeenAt: "2026-08-03T07:00:00.000Z" }, second]);
    expect(() =>
      state.catalog.resolveForRun(
        endpoint.endpointId,
        "workspace-a",
        ["acp.codex"],
        "collaboration"
      )
    ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_unavailable"));
  });

  it("returns one stable unknown error when the endpoint identity disappears", () => {
    const state = fixture();
    const endpoint = state.catalog.listVisibleFleet().items[0]!;
    state.setHosts([]);
    expect(() =>
      state.catalog.resolveForRun(endpoint.endpointId, "workspace-a", [], "collaboration")
    ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_unknown"));
  });

  it("returns opaque, strictly redacted projections", () => {
    const serialized = JSON.stringify(fixture().catalog.listVisibleFleet());
    expect(serialized).not.toContain("host-primary");
    for (const sensitive of [
      '"hostId"',
      '"command"',
      '"args"',
      '"env"',
      '"token"',
      '"path"',
      '"readinessObservation"'
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });
});
