import {
  CANVAS_RUNTIME_EXECUTION_CAPABILITY,
  type HostAcpProfileObservation
} from "@planweave-ai/agent-host-protocol";
import { describe, expect, it, vi } from "vitest";
import { endpointIdFor } from "../agentEndpointCatalog.js";
import { endpointDispatchRequest } from "./support/endpointCoordinatorFixture.js";
import { OwnerCanvasRestartHarness, setup } from "./support/remoteBlockCoordinatorFixture.js";

const profile = {
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Test Agent",
  status: "ready",
  capabilities: ["acp.codex"]
} satisfies HostAcpProfileObservation;
const capabilities = ["acp.codex", CANVAS_RUNTIME_EXECUTION_CAPABILITY];
const requiredCapabilities = ["acp.codex"];
const workspacePolicy = { kind: "workspace" } as const;
const ownerFleetPolicy = { kind: "owner_fleet" } as const;

function endpointFor(hostId: string) {
  return endpointIdFor({ hostId, profileId: profile.profileId, agentId: profile.agentId });
}

type Fixture = Awaited<ReturnType<typeof setup>>;

function requireHost(fixture: Fixture) {
  if (!fixture.host) throw new Error("expected_test_host");
  return fixture.host;
}

function reportReady(
  fixture: Fixture,
  hostId: string,
  profiles: HostAcpProfileObservation[],
  hostCapabilities = capabilities
) {
  return fixture.hosts.reportOnline(hostId, hostCapabilities, 1, {
    workspaceMappings: [],
    acpProfiles: profiles
  });
}

describe("SQLite Endpoint dispatch", () => {
  it("dispatches on the first readiness report with work independent of fleet size", async () => {
    const counts = [];
    for (const fleetSize of [1, 100, 1000]) {
      const fixture = await setup(true);
      const hostId = requireHost(fixture).id;
      const endpointId = endpointFor(hostId);
      for (let index = 1; index < fleetSize; index += 1) {
        const other = fixture.hosts.register(`Other Host ${index}`).host;
        reportReady(fixture, other.id, [profile]);
      }
      expect(
        fixture.server.database.prepare("SELECT COUNT(*) AS n FROM agent_hosts").get()
      ).toEqual({ n: fleetSize });

      const listHosts = vi.spyOn(fixture.hosts, "listActiveHosts");
      const readHost = vi.spyOn(fixture.hosts, "getActiveHost");
      const readIdentity = vi.spyOn(fixture.remoteAgents, "getByEndpointId");
      const readCapacity = vi.spyOn(fixture.reservations, "activeCountsForHosts");
      const request = endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.dispatchLocator,
        blockRef: "T-001#B-001",
        idempotencyKey: "direct-endpoint",
        agentEndpointId: endpointId
      });
      const start = performance.now();
      const outcome = await fixture.coordinator.dispatch(request);
      const elapsedMs = performance.now() - start;
      expect(outcome).toMatchObject({
        status: "activated",
        operation: {
          attempt: { hostId, status: "activated" },
          endpointSelection: {
            endpointId,
            hostId,
            profileId: profile.profileId,
            agentId: profile.agentId,
            capabilities: profile.capabilities
          }
        }
      });
      expect(fixture.mailbox.listAfter(hostId, 0)).toMatchObject([
        { command: { type: "execute_block", dispatchId: outcome.operation.dispatchId } }
      ]);

      const reads = {
        listCalls: listHosts.mock.calls.length,
        hostReads: readHost.mock.calls.length,
        identityReads: readIdentity.mock.calls.length,
        capacityReads: readCapacity.mock.calls.length,
        capacityHostIds: readCapacity.mock.calls.flatMap(([ids]) => ids).length
      };
      counts.push(reads);
      console.info("SQLite Endpoint dispatch", { fleetSize, ...reads, elapsedMs });
      expect.soft(listHosts).not.toHaveBeenCalled();
      expect.soft(readHost).toHaveBeenCalled();
      expect.soft(readCapacity).toHaveBeenCalled();
      expect.soft(readHost.mock.calls.every(([id]) => id === hostId)).toBe(true);
      expect.soft(readIdentity.mock.calls.every(([id]) => id === endpointId)).toBe(true);
      expect
        .soft(readCapacity.mock.calls.every(([ids]) => ids.length === 1 && ids[0] === hostId))
        .toBe(true);
    }
    expect(counts[1]).toEqual(counts[0]);
    expect(counts[2]).toEqual(counts[0]);
  });

  it("dispatches directly after cold composition rebuild using persisted first readiness", async () => {
    const harness = await OwnerCanvasRestartHarness.create();
    const original = harness.requireCoordination();
    const originalList = vi.spyOn(original.hosts, "listActiveHosts");
    const hostId = harness.registerHost();
    const endpointId = endpointFor(hostId);
    expect(original.remoteAgents.getByEndpointId(endpointId)).toMatchObject({ hostId });
    expect(originalList).not.toHaveBeenCalled();

    const rebuilt = await harness.start();
    const rebuiltList = vi.spyOn(rebuilt.hosts, "listActiveHosts");
    const outcome = await rebuilt.coordinator.dispatch(
      harness.request("first-dispatch-after-rebuild", endpointId)
    );

    expect(outcome).toMatchObject({
      status: "activated",
      operation: { endpointSelection: { endpointId, hostId, authority: { kind: "owner_canvas" } } }
    });
    expect(rebuilt.mailbox.listAfter(hostId, 0)).toMatchObject([
      { command: { type: "execute_block", dispatchId: outcome.operation.dispatchId } }
    ]);
    expect(rebuiltList).not.toHaveBeenCalled();
  });

  it("rolls back first readiness and all Endpoint registrations when registration fails", async () => {
    const fixture = await setup(false);
    const host = fixture.hosts.register("First Readiness Host").host;
    const endpointId = endpointFor(host.id);
    const failingProfile = { ...profile, profileId: "fixture-failed-registration" };
    fixture.server.database.exec(`
      CREATE TEMP TRIGGER fail_first_readiness_registration
      BEFORE INSERT ON remote_agents
      WHEN NEW.profile_id='fixture-failed-registration'
      BEGIN SELECT RAISE(ABORT,'injected_endpoint_registration_failure'); END;
    `);

    expect(() => reportReady(fixture, host.id, [profile, failingProfile])).toThrow(
      "injected_endpoint_registration_failure"
    );
    expect(fixture.hosts.getRequired(host.id)).toEqual(host);
    expect(fixture.remoteAgents.getByEndpointId(endpointId)).toBeUndefined();
    expect(fixture.mailbox.listAfter(host.id, 0)).toEqual([]);

    reportReady(fixture, host.id, [profile]);
    expect(
      fixture.agentEndpoints.resolveForRun(
        endpointId,
        fixture.locator.workspaceId,
        requiredCapabilities,
        workspacePolicy
      )
    ).toMatchObject({ endpointId, hostId: host.id });
  });

  it("rejects an Endpoint whose persisted profile identity no longer matches its ID", async () => {
    const fixture = await setup(true);
    const hostId = requireHost(fixture).id;
    const endpointId = endpointFor(hostId);
    const { workspaceId } = fixture.locator;
    const replacement = { ...profile, profileId: "replacement-profile" };
    const readiness = { workspaceMappings: [], acpProfiles: [profile, replacement] };
    const catalog = fixture.agentEndpoints;
    expect(catalog.resolveForSnapshot(endpointId, workspaceId, requiredCapabilities)).toMatchObject(
      { endpointId, profileId: profile.profileId }
    );
    fixture.server.database
      .prepare("UPDATE agent_hosts SET readiness_json=? WHERE id=?")
      .run(JSON.stringify(readiness), hostId);
    fixture.server.database
      .prepare("UPDATE remote_agents SET profile_id=? WHERE endpoint_id=?")
      .run(replacement.profileId, endpointId);

    expect(catalog.listVisibleFleet().items).toContainEqual(
      expect.objectContaining({ endpointId, status: "available" })
    );
    expect(() => catalog.resolveForSnapshot(endpointId, workspaceId, requiredCapabilities)).toThrow(
      "agent_endpoint_unknown"
    );
    expect(() =>
      catalog.resolveForRun(endpointId, workspaceId, requiredCapabilities, workspacePolicy)
    ).toThrow("agent_endpoint_unknown");
  });

  it.each([
    { profiles: [], reason: undefined },
    { profiles: [{ ...profile, status: "missing" as const }], reason: "profile_missing" },
    { profiles: [{ ...profile, status: "invalid" as const }], reason: "profile_invalid" },
    { profiles: [profile, { ...profile, displayName: "Duplicate" }], reason: "profile_invalid" }
  ])("projects and resolves current profile observations with reason $reason", async ({
    profiles,
    reason
  }) => {
    const fixture = await setup(true);
    const hostId = requireHost(fixture).id;
    const endpointId = endpointFor(hostId);
    const { workspaceId } = fixture.locator;
    reportReady(fixture, hostId, profiles);

    expect(fixture.remoteAgents.getByEndpointId(endpointId)).toMatchObject({ hostId });
    const listed = fixture.agentEndpoints.listVisible(workspaceId).items;
    const code = reason ? "agent_endpoint_unavailable" : "agent_endpoint_unknown";
    if (reason) {
      expect(listed).toMatchObject([
        { endpointId, status: "unavailable", unavailableReason: reason }
      ]);
      expect(
        fixture.agentEndpoints.resolveForSnapshot(endpointId, workspaceId, requiredCapabilities)
      ).toMatchObject({ endpointId, displayName: profile.displayName });
    } else {
      expect(listed).toEqual([]);
      expect(() =>
        fixture.agentEndpoints.resolveForSnapshot(endpointId, workspaceId, requiredCapabilities)
      ).toThrow(code);
    }
    expect(() =>
      fixture.agentEndpoints.resolveForRun(
        endpointId,
        workspaceId,
        requiredCapabilities,
        workspacePolicy
      )
    ).toThrow(code);
    expect(() =>
      fixture.agentEndpoints.resolveForReservedRun(
        endpointId,
        workspaceId,
        requiredCapabilities,
        hostId,
        workspacePolicy
      )
    ).toThrow(code);
  });

  it.each([
    "revoked",
    "credential_expired",
    "offline"
  ] as const)("rejects a persisted Endpoint for a %s Host", async (state) => {
    const fixture = await setup(true);
    const hostId = requireHost(fixture).id;
    const endpointId = endpointFor(hostId);
    const { workspaceId } = fixture.locator;
    if (state === "revoked") fixture.hosts.revoke(hostId);
    else if (state === "credential_expired") {
      fixture.server.database
        .prepare("UPDATE agent_hosts SET credential_expires_at=? WHERE id=?")
        .run(new Date(0).toISOString(), hostId);
    } else fixture.hosts.touch(hostId, new Date(0));

    expect(fixture.remoteAgents.getByEndpointId(endpointId)).toMatchObject({ hostId });
    const code = state === "offline" ? "agent_endpoint_unavailable" : "agent_endpoint_unknown";
    expect(() =>
      fixture.agentEndpoints.resolveForRun(
        endpointId,
        workspaceId,
        requiredCapabilities,
        workspacePolicy
      )
    ).toThrow(code);
    expect(() =>
      fixture.agentEndpoints.resolveForReservedRun(
        endpointId,
        workspaceId,
        requiredCapabilities,
        hostId,
        workspacePolicy
      )
    ).toThrow(code);
    if (state === "offline") {
      expect(fixture.agentEndpoints.listVisible(workspaceId).items).toMatchObject([
        { endpointId, status: "unavailable", unavailableReason: "host_offline" }
      ]);
      expect(
        fixture.agentEndpoints.resolveForSnapshot(endpointId, workspaceId, requiredCapabilities)
      ).toMatchObject({ endpointId });
    } else {
      expect(fixture.agentEndpoints.listVisible(workspaceId).items).toEqual([]);
      expect(() =>
        fixture.agentEndpoints.resolveForSnapshot(endpointId, workspaceId, requiredCapabilities)
      ).toThrow(code);
    }
  });

  it("distinguishes missing Host and profile capabilities across policies", async () => {
    const fixture = await setup(true);
    const hostId = requireHost(fixture).id;
    const endpointId = endpointFor(hostId);
    const { workspaceId } = fixture.locator;
    reportReady(fixture, hostId, [profile], ["acp.codex", "host-only"]);
    const catalog = fixture.agentEndpoints;
    expect(catalog.listVisible(workspaceId).items).toMatchObject([
      { endpointId, unavailableReason: "host_capability_missing" }
    ]);
    expect(catalog.listVisibleFleet().items).toMatchObject([{ endpointId, status: "available" }]);
    expect(() =>
      catalog.resolveForRun(endpointId, workspaceId, requiredCapabilities, workspacePolicy)
    ).toThrow("agent_endpoint_unavailable");
    expect(() =>
      catalog.resolveForReservedRun(
        endpointId,
        workspaceId,
        requiredCapabilities,
        hostId,
        workspacePolicy
      )
    ).toThrow("agent_endpoint_unavailable");
    expect(
      catalog.resolveForRun(endpointId, workspaceId, requiredCapabilities, ownerFleetPolicy)
    ).toMatchObject({ endpointId });
    expect(() => catalog.resolveForSnapshot(endpointId, workspaceId, ["host-only"])).toThrow(
      "agent_endpoint_incompatible"
    );
    expect(() =>
      catalog.resolveForRun(endpointId, workspaceId, ["host-only"], ownerFleetPolicy)
    ).toThrow("agent_endpoint_incompatible");
  });

  it("discounts real capacity only for the matching reserved Host and owner fleet", async () => {
    const fixture = await setup(true);
    const hostId = requireHost(fixture).id;
    const endpointId = endpointFor(hostId);
    const { workspaceId } = fixture.locator;
    const otherHost = fixture.hosts.register("Other Host").host;
    reportReady(fixture, otherHost.id, [profile]);
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "occupy-endpoint",
      agentEndpointId: endpointId
    });
    expect(await fixture.coordinator.dispatch(request)).toMatchObject({
      operation: { attempt: { hostId, leaseId: expect.any(String) } }
    });
    const catalog = fixture.agentEndpoints;
    expect(catalog.listProjected({ kind: "owner_workspace" }, workspaceId).items).toContainEqual(
      expect.objectContaining({ endpointId, unavailableReason: "at_capacity" })
    );
    expect(catalog.resolveForSnapshot(endpointId, workspaceId, requiredCapabilities)).toMatchObject(
      { endpointId, hostId }
    );
    expect(() =>
      catalog.resolveForRun(endpointId, workspaceId, requiredCapabilities, workspacePolicy)
    ).toThrow("agent_endpoint_unavailable");
    expect(
      catalog.resolveForRun(endpointId, workspaceId, requiredCapabilities, ownerFleetPolicy)
    ).toMatchObject({ endpointId, hostId });
    expect(() =>
      catalog.resolveForReservedRun(
        endpointId,
        workspaceId,
        requiredCapabilities,
        otherHost.id,
        workspacePolicy
      )
    ).toThrow("agent_endpoint_unknown");
    expect(
      catalog.resolveForReservedRun(
        endpointId,
        workspaceId,
        requiredCapabilities,
        hostId,
        workspacePolicy
      )
    ).toMatchObject({ endpointId, hostId });
  });
});
