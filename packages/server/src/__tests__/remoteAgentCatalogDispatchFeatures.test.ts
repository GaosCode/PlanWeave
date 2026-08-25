import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentEndpointCatalog,
  AgentEndpointCatalogError,
  endpointIdFor,
  legacyEndpointIdFor,
  type AgentEndpointCapacityPort,
  type AgentEndpointHostPort
} from "../agentEndpointCatalog.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { availabilityScopeForAuthorized, dispatchTarget } from "../remoteAgent/dispatchTarget.js";
import { AgentHostRepository, type AgentHost } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { RemoteBlockCoordinator } from "../remoteBlockCoordinator.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const now = new Date("2026-08-03T08:00:00.000Z");
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

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

function catalogFixture(hostsInput: AgentHost[] = [readyHost()]) {
  const hosts = hostsInput;
  let counts = new Map<string, number>();
  const hostPort: AgentEndpointHostPort = {
    listActiveHosts: (limit, offset) => activeHosts(hosts).slice(offset, offset + limit)
  };
  const capacityPort: AgentEndpointCapacityPort = {
    activeCountsForHosts: (hostIds) =>
      new Map(hostIds.map((hostId) => [hostId, counts.get(hostId) ?? 0]))
  };
  return {
    catalog: new AgentEndpointCatalog({
      hosts: hostPort,
      capacities: capacityPort,
      hostOfflineAfterMs: 60_000,
      clock: () => now
    }),
    setActive(hostId: string, count: number) {
      counts = new Map(counts).set(hostId, count);
    }
  };
}

async function sqliteCatalogFixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const identity = new WorkspaceIdentityRepository(database);
  const workspaceA = identity.ensureWorkspaceForLegacyProject("project-a");
  const workspaceB = identity.ensureWorkspaceForLegacyProject("project-b");
  const hosts = new AgentHostRepository(database, () => now);
  const capacities: AgentEndpointCapacityPort = {
    activeCountsForHosts: (hostIds) => new Map(hostIds.map((hostId) => [hostId, 0]))
  };
  const catalog = new AgentEndpointCatalog({
    hosts,
    capacities,
    hostOfflineAfterMs: 60_000,
    clock: () => now
  });
  return { catalog, hosts, workspaceA, workspaceB };
}

function reportReady(
  hosts: AgentHostRepository,
  hostId: string,
  workspaceIds: readonly string[],
  capacity = 2
) {
  hosts.reportOnline(hostId, ["acp.codex"], capacity, {
    workspaceMappings: workspaceIds.map((workspaceId) => ({
      workspaceId,
      status: "ready" as const
    })),
    acpProfiles: [
      {
        profileId: "profile-main",
        agentId: "codex",
        displayName: "Codex",
        status: "ready",
        capabilities: ["acp.codex"]
      }
    ]
  });
}

describe("Phase 5 catalog/dispatch authorization", () => {
  describe("Endpoint ID does not include workspaceId", () => {
    it("keeps endpointIdFor stable across workspaces and presentation changes", () => {
      const host = readyHost();
      const id = endpointIdFor({
        hostId: host.id,
        profileId: "profile-main",
        agentId: "codex"
      });
      const state = catalogFixture([host]);
      const workspaceA = state.catalog.listVisible("workspace-a").items[0]!;
      const workspaceB = state.catalog.listVisible("workspace-b").items[0]!;
      expect(workspaceA.endpointId).toBe(id);
      expect(workspaceB.endpointId).toBe(id);
      const renamed = catalogFixture([
        readyHost({
          displayName: "Renamed Host",
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
      ]).catalog.listVisibleFleet().items[0]!;
      expect(renamed.endpointId).toBe(id);
      expect(renamed).toMatchObject({ status: "unavailable", unavailableReason: "host_offline" });
    });

    it("does not resolve retired workspace-scoped ids", () => {
      const state = catalogFixture();
      const endpoint = state.catalog.listVisibleFleet().items[0]!;
      const legacyId = legacyEndpointIdFor({
        workspaceId: "workspace-a",
        hostId: "host-primary",
        profileId: "profile-main",
        agentId: "codex"
      });
      expect(legacyId).not.toBe(endpoint.endpointId);
      expect(() =>
        state.catalog.resolveForRun(legacyId, "workspace-a", ["acp.codex"], "workspace_canvas")
      ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_unknown"));
    });
  });

  describe("Owner Fleet vs Workspace Catalog availability overlay", () => {
    it("lists fleet hosts without workspace mapping and overlays mapping on workspace listing", async () => {
      const unbound = readyHost({
        readinessObservation: {
          workspaceMappings: [],
          acpProfiles: readyHost().readinessObservation!.acpProfiles
        }
      });
      const unboundCatalog = catalogFixture([unbound]);
      expect(unboundCatalog.catalog.listVisibleFleet().items[0]).toMatchObject({
        status: "available"
      });
      expect(unboundCatalog.catalog.listVisible("workspace-a").items[0]).toMatchObject({
        status: "unavailable",
        unavailableReason: "workspace_mapping_missing"
      });

      const sqlite = await sqliteCatalogFixture();
      const exclusive = sqlite.hosts.register("Exclusive Host").host;
      sqlite.hosts.bindToWorkspace(exclusive.id, sqlite.workspaceA);
      reportReady(sqlite.hosts, exclusive.id, [sqlite.workspaceA]);
      expect(sqlite.hosts.listExclusivelyBoundToWorkspace(sqlite.workspaceA)).toHaveLength(1);
      expect(sqlite.catalog.listVisible(sqlite.workspaceA).items).toHaveLength(1);
      expect(sqlite.catalog.listVisible(sqlite.workspaceB).items[0]).toMatchObject({
        status: "unavailable",
        unavailableReason: "workspace_mapping_missing"
      });
      expect(sqlite.catalog.listVisibleFleet().items).toHaveLength(1);
    });

    it("lists a host bound to multiple workspaces in each workspace overlay", async () => {
      const sqlite = await sqliteCatalogFixture();
      const shared = sqlite.hosts.register("Shared Host").host;
      sqlite.hosts.bindToWorkspace(shared.id, sqlite.workspaceA);
      sqlite.hosts.bindToWorkspace(shared.id, sqlite.workspaceB);
      reportReady(sqlite.hosts, shared.id, [sqlite.workspaceA, sqlite.workspaceB]);
      expect(sqlite.hosts.listExclusivelyBoundToWorkspace(sqlite.workspaceA)).toEqual([]);
      expect(sqlite.hosts.listExclusivelyBoundToWorkspace(sqlite.workspaceB)).toEqual([]);
      expect(sqlite.catalog.listVisible(sqlite.workspaceA).items).toHaveLength(1);
      expect(sqlite.catalog.listVisible(sqlite.workspaceB).items).toHaveLength(1);
      expect(sqlite.catalog.listVisibleFleet().items).toHaveLength(1);
    });

    it("keeps Owner Fleet available when collaboration capacity is occupied", () => {
      const state = catalogFixture();
      const before = state.catalog.listVisibleFleet().items[0]!;
      state.setActive("host-primary", 2);
      const after = state.catalog.listVisibleFleet().items[0]!;
      expect(after.endpointId).toBe(before.endpointId);
      expect(after).toMatchObject({ status: "available" });
      expect(state.catalog.listVisible("workspace-a").items[0]).toMatchObject({
        status: "unavailable",
        unavailableReason: "at_capacity"
      });
    });
  });

  describe("Owner canvas vs workspace canvas resolve scope", () => {
    it("resolveForRun owner_canvas uses fleet scope even at collaboration capacity", () => {
      const state = catalogFixture();
      const endpoint = state.catalog.listVisibleFleet().items[0]!;
      state.setActive("host-primary", 2);
      expect(
        state.catalog.resolveForRun(
          endpoint.endpointId,
          "workspace-a",
          ["acp.codex"],
          "owner_canvas"
        )
      ).toMatchObject({ hostId: "host-primary" });
      expect(() =>
        state.catalog.resolveForRun(
          endpoint.endpointId,
          "workspace-a",
          ["acp.codex"],
          "workspace_canvas"
        )
      ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_unavailable"));
    });

    it("workspace_canvas resolve requires a ready mapping even without exclusive bind", () => {
      const host = readyHost({
        readinessObservation: {
          workspaceMappings: [],
          acpProfiles: readyHost().readinessObservation!.acpProfiles
        }
      });
      const state = catalogFixture([host]);
      const endpoint = state.catalog.listVisibleFleet().items[0]!;
      expect(state.catalog.listVisible("workspace-a").items[0]).toMatchObject({
        status: "unavailable",
        unavailableReason: "workspace_mapping_missing"
      });
      expect(
        state.catalog.resolveForRun(
          endpoint.endpointId,
          "workspace-a",
          ["acp.codex"],
          "owner_canvas"
        )
      ).toMatchObject({ hostId: "host-primary", profileId: "profile-main", agentId: "codex" });
      expect(() =>
        state.catalog.resolveForRun(
          endpoint.endpointId,
          "workspace-a",
          ["acp.codex"],
          "workspace_canvas"
        )
      ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_unavailable"));
    });

    it("keeps unknown and incompatible distinct from unavailable", () => {
      const state = catalogFixture();
      const endpoint = state.catalog.listVisibleFleet().items[0]!;
      expect(() =>
        state.catalog.resolveForRun(
          "aep_missingendpointid01",
          "workspace-a",
          [],
          "workspace_canvas"
        )
      ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_unknown"));
      expect(() =>
        state.catalog.resolveForRun(
          endpoint.endpointId,
          "workspace-a",
          ["host-only"],
          "workspace_canvas"
        )
      ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_incompatible"));
    });
  });

  describe("RemoteExecutionTarget locator", () => {
    it("builds owner_canvas from targetKind without using the runtime workspace as a grant", () => {
      expect(
        dispatchTarget({
          projectId: "project-a",
          canvasId: "canvas-main",
          workspaceId: "workspace-internal",
          targetKind: "owner_canvas"
        })
      ).toEqual({
        kind: "owner_canvas",
        projectId: "project-a",
        canvasId: "canvas-main"
      });
    });

    it("builds workspace_canvas from the locator kind and workspaceId", () => {
      expect(
        dispatchTarget({
          projectId: "project-a",
          canvasId: "canvas-main",
          workspaceId: "workspace-a",
          targetKind: "workspace_canvas"
        })
      ).toEqual({
        kind: "workspace_canvas",
        workspaceId: "workspace-a",
        projectId: "project-a",
        canvasId: "canvas-main"
      });
    });

    it("uses fleet availability for unrestricted owners writing back to a workspace canvas", () => {
      expect(
        availabilityScopeForAuthorized({
          remoteAgent: {
            endpointId: "aep_unrestrictedowner01",
            hostId: "host-primary",
            profileId: "profile-main",
            agentId: "codex"
          },
          runtimeAuthority: { kind: "workspace_canvas", workspaceId: "workspace-b" },
          agentAccessAuthority: {
            kind: "agent_owner",
            ownerHumanPrincipalId: "owner-human-1",
            policyRevision: 1
          },
          resolvedAt: now.toISOString()
        })
      ).toBe("owner_canvas");
      expect(
        availabilityScopeForAuthorized({
          remoteAgent: {
            endpointId: "aep_grantscopedagent01",
            hostId: "host-primary",
            profileId: "profile-main",
            agentId: "codex"
          },
          runtimeAuthority: { kind: "workspace_canvas", workspaceId: "workspace-b" },
          agentAccessAuthority: {
            kind: "workspace_grant",
            workspaceId: "workspace-b",
            grantRevision: 1,
            policyRevision: 1
          },
          resolvedAt: now.toISOString()
        })
      ).toBe("workspace_canvas");
    });
  });

  describe("Shared Remote Coordinator path", () => {
    it("createRemoteBlockCoordination constructs a single RemoteBlockCoordinator", async () => {
      const database = await openServerDatabase(":memory:", 5_000);
      databases.push(database);
      applyMigrations(database);
      const coordination = createRemoteBlockCoordination(
        database,
        {
          leaseDurationMs: 60_000,
          hostOfflineAfterMs: 60_000,
          clock: () => now,
          runtimeLeases: {
            acquire: () => {
              throw new Error("runtime_not_configured");
            }
          },
          inputArtifacts: { materialize: async () => undefined },
          artifactContent: { readReport: async () => new Uint8Array() },
          enableAssignmentDispatchGate: false
        },
        { serverInstanceOwnerToken: "remote-agent-phase0-coordinator" }
      );
      expect(coordination.coordinator).toBeInstanceOf(RemoteBlockCoordinator);
      expect(coordination.agentEndpoints).toBeInstanceOf(AgentEndpointCatalog);
    });

    it("Owner and Human remote control both receive the same composed coordinator", () => {
      const coordinationSource = readFileSync(
        fileURLToPath(new URL("../distributedCoordination.ts", import.meta.url)),
        "utf8"
      );
      const remoteExecutionSource = readFileSync(
        fileURLToPath(new URL("../composition/remoteExecution.ts", import.meta.url)),
        "utf8"
      );
      expect(coordinationSource).toContain("const coordinator = new RemoteBlockCoordinator({");
      expect((coordinationSource.match(/new RemoteBlockCoordinator\(/g) ?? []).length).toBe(1);
      expect(remoteExecutionSource).toContain("new HumanRemoteControlService({");
      expect(remoteExecutionSource).toContain("return new RemoteControlService({");
      expect(
        (remoteExecutionSource.match(/coordinator: input\.coordination\.coordinator/g) ?? []).length
      ).toBe(2);
    });
  });
});
