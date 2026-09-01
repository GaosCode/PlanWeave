import { describe, expect, it } from "vitest";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { HostEnrollmentService } from "../hostEnrollment.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";
import { RemoteControlService } from "../remoteControlService.js";
import {
  completeDispatchToTerminal,
  remoteManifest,
  setupFleetUnboundHost
} from "./support/remoteBlockCoordinatorFixture.js";
import { TEST_REMOTE_AGENT_OWNER_ID } from "./support/remoteAgentOwnerFixture.js";

describe("RemoteBlockCoordinator owner Canvas execution", () => {
  it("dispatches an unbound fleet host through managed Canvas Runtime materialization", async () => {
    const fixture = await setupFleetUnboundHost();
    const endpoint = fixture.agentEndpoints.listVisibleFleet().items[0];
    if (!endpoint) throw new Error("expected_fleet_endpoint");
    expect(endpoint.status).toBe("available");
    const expectedEvidence = await fixture.runtimeInitializationEvidenceFor(fixture.locator)();

    const outcome = await fixture.coordinator.dispatch({
      ...fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "fleet-unbound-dispatch",
      agentEndpointId: endpoint.endpointId,
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      executionTargetRevision: 0,
      targetKind: "owner_canvas",
      callerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
    });
    expect(outcome.status).toBe("activated");

    const command = fixture.mailbox.listAfter(fixture.host.id, 0)[0]?.command;
    expect(command).toMatchObject({
      envelope: {
        runtimeMaterialization: {
          sourceRevision: expectedEvidence.sourceRevision,
          graphFingerprint: expectedEvidence.graphFingerprint
        }
      }
    });
    expect(command?.envelope).not.toHaveProperty("ownerPackageLocator");

    await completeDispatchToTerminal(fixture, outcome);
    expect(fixture.operations.getRequired(outcome.operation.id).state).toBe("completed");
    await expect(
      fixture.runtime.query({ ref: "T-001#B-001", operationId: outcome.operation.id })
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("reads a completed owner-canvas terminal report through the private Operator contract", async () => {
    const fixture = await setupFleetUnboundHost();
    const endpoint = fixture.agentEndpoints.listVisibleFleet().items[0];
    if (!endpoint) throw new Error("expected_fleet_endpoint");
    const outcome = await fixture.coordinator.dispatch({
      ...fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "owner-terminal-result-contract",
      agentEndpointId: endpoint.endpointId,
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      executionTargetRevision: 0,
      targetKind: "owner_canvas",
      callerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
    });
    await completeDispatchToTerminal(fixture, outcome);
    const token = `pw_operator_${"T".repeat(43)}`;
    new OperatorSessionStore(fixture.server.database).create({
      workspaceId: fixture.locator.workspaceId,
      operatorId: "operator-terminal-result",
      credentialSha256: hashOperatorToken(token),
      issuedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    const authorization = new OperatorTokenRegistry(fixture.server.database, [
      {
        operatorId: "operator-terminal-result",
        tokenSha256: hashOperatorToken(token),
        projectIds: [],
        serverAdmin: true
      }
    ]);
    const principal = authorization.authenticate(`Bearer ${token}`);
    if (!principal) throw new Error("expected_operator_principal");
    const control = new RemoteControlService({
      authorization,
      enrollments: new HostEnrollmentService(fixture.server.database),
      hosts: fixture.hosts,
      agentEndpoints: fixture.agentEndpoints,
      remoteAgentAccess: fixture.remoteAgentAccess,
      remoteAgentRepository: fixture.remoteAgents,
      operations: fixture.operations,
      dispatches: fixture.dispatches,
      coordinator: fixture.coordinator,
      events: fixture.acpEvents,
      interactions: fixture.interactions,
      artifactContent: { readReport: async (ref) => fixture.artifacts.read(ref) },
      disconnectHost: () => {},
      workspaceIdentity: new WorkspaceIdentityRepository(fixture.server.database),
      authorizeProjectScope: () => {},
      resolveOwnerRuntimeScope: () => fixture.locator
    });

    await expect(
      control.readOwnerOperationTerminalResult(
        { ...principal, humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID },
        outcome.operation.id
      )
    ).resolves.toEqual({
      metadata: {
        operationId: outcome.operation.id,
        projectId: fixture.locator.projectId,
        canvasId: fixture.locator.canvasId,
        blockRef: "T-001#B-001",
        controlPlane: "owner",
        sourceRevision: outcome.operation.ownershipGeneration,
        graphFingerprint: outcome.operation.sourceFingerprint,
        dispatchId: outcome.operation.dispatchId,
        executionAttemptId: outcome.operation.executionAttemptId,
        reportArtifactRef: expect.stringMatching(/^artifact:sha256:[a-f0-9]{64}$/)
      },
      reportBytes: Buffer.from("# Remote result\n\nCompleted by the remote host.\n")
    });
  });

  it("dispatches an unrestricted owner agent to a workspace canvas without host mapping", async () => {
    const fixture = await setupFleetUnboundHost();
    const endpoint = fixture.agentEndpoints.listVisibleFleet().items[0];
    if (!endpoint) throw new Error("expected_fleet_endpoint");
    expect(endpoint.status).toBe("available");
    expect(fixture.agentEndpoints.listVisible(fixture.locator.workspaceId).items[0]).toMatchObject({
      status: "available"
    });

    const outcome = await fixture.coordinator.dispatch({
      ...fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "workspace-unmapped-unrestricted-dispatch",
      agentEndpointId: endpoint.endpointId,
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      executionTargetRevision: 0,
      targetKind: "workspace_canvas",
      callerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
    });
    expect(outcome.status).toBe("activated");
    expect(outcome.operation.agentAccess?.authorized).toMatchObject({
      runtimeAuthority: {
        kind: "workspace_canvas",
        workspaceId: fixture.locator.workspaceId
      },
      agentAccessAuthority: { kind: "agent_owner" }
    });
    expect(fixture.mailbox.listAfter(fixture.host.id, 0)).toHaveLength(1);
  });

  it("admits multiple owner fleet operations beyond collaboration Host capacity", async () => {
    const manifest = remoteManifest();
    const secondTask = basicManifest({ includeSecondTask: true }).nodes.find(
      (node) => node.id === "T-002"
    );
    if (!secondTask) throw new Error("expected_second_task");
    manifest.nodes.push(secondTask);
    manifest.execution.parallel = { enabled: true, maxConcurrent: 2 };
    const fixture = await setupFleetUnboundHost(manifest);
    const endpoint = fixture.agentEndpoints.listVisibleFleet().items[0];
    if (!endpoint) throw new Error("expected_fleet_endpoint");

    const dispatchOwner = (blockRef: string, idempotencyKey: string) =>
      fixture.coordinator.dispatch({
        ...fixture.dispatchLocator,
        blockRef,
        idempotencyKey,
        agentEndpointId: endpoint.endpointId,
        targetKind: "owner_canvas",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        executionTargetRevision: 0,
        callerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
      });

    const [first, second] = await Promise.all([
      dispatchOwner("T-001#B-001", "owner-capacity-first"),
      dispatchOwner("T-002#B-001", "owner-capacity-second")
    ]);

    expect(first.status).toBe("activated");
    expect(second.status).toBe("activated");
    expect(fixture.mailbox.listAfter(fixture.host.id, 0)).toHaveLength(2);
    expect(fixture.reservations.activeCountsForHosts([fixture.host.id]).get(fixture.host.id)).toBe(
      0
    );
    expect(
      fixture.server.database
        .prepare(
          "SELECT COUNT(*) AS active FROM host_capacity_reservations WHERE host_id=? AND status='active'"
        )
        .get(fixture.host.id)
    ).toEqual({ active: 2 });
  });
});
