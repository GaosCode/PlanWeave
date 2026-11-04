import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  deviceSessionIdSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { HumanRemoteControlService } from "../humanRemoteControlService.js";
import { endpointDispatchRequest } from "./support/endpointCoordinatorFixture.js";
import { setup } from "./support/remoteBlockCoordinatorFixture.js";

describe("Human observation before remote dispatch", () => {
  it.each([
    "none",
    "same",
    "foreign"
  ])("cancels preparation only for matching Runtime ownership: %s", async (owner) => {
    const fixture = await setup(true);
    const candidate = await fixture.runtime.inspect({ ref: "T-001#B-001" });
    const operation = fixture.operations.create({
      ...fixture.locator,
      blockRef: "T-001#B-001",
      ownershipGeneration: candidate.sourceRevision,
      idempotencyKey: "interrupted-before-runtime-claim",
      sourceFingerprint: candidate.graphFingerprint,
      requiredCapabilities: ["acp.codex"]
    });
    const reservation = fixture.reservations.reserve(operation.id, {
      agentId: "codex",
      agentProfileId: "codex-acp"
    });
    if (owner !== "none") {
      await fixture.runtime.claim({
        ref: operation.blockRef,
        operationId: owner === "foreign" ? "foreign-operation" : operation.id,
        controlPlane: "collaboration",
        sourceRevision: candidate.sourceRevision,
        graphFingerprint: candidate.graphFingerprint
      });
    }
    fixture.reservations.release({
      leaseId: reservation.leaseId,
      fencingToken: reservation.fencingToken,
      expectedVersion: reservation.version,
      reason: "expired"
    });
    expect(fixture.operations.getRequired(operation.id).state).toBe("interrupted");
    expect(fixture.dispatches.get(operation.dispatchId)).toBeUndefined();
    const query = vi.spyOn(fixture.coordinator, "query");
    const service = new HumanRemoteControlService({
      operations: fixture.operations,
      dispatches: fixture.dispatches,
      coordinator: fixture.coordinator,
      events: fixture.acpEvents,
      interactions: fixture.interactions
    });
    const workspaceId = workspaceIdSchema.parse(fixture.locator.workspaceId);
    const observation = await service.lookupLatestOperation(
      {
        workspaceId,
        projectId: fixture.locator.projectId,
        actor: {
          kind: "workspace_device",
          workspaceId,
          projectId: fixture.locator.projectId,
          deviceSessionId: deviceSessionIdSchema.parse("device-session-test"),
          humanPrincipalId: "human-test",
          displayName: "Test member"
        }
      },
      { canvasId: fixture.locator.canvasId, blockRef: operation.blockRef }
    );
    expect(observation).toMatchObject({
      operationId: operation.id,
      state: "interrupted",
      runtime: { ref: operation.blockRef, status: "not_started" }
    });
    expect(observation?.runtime.ownership).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    const interrupted = fixture.operations.getRequired(operation.id);
    const action = {
      kind: "cancel" as const,
      actionId: "cancel-unstarted-preparation",
      operationId: operation.id,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      leaseId: reservation.leaseId,
      reason: "User stopped before execution started."
    };
    if (owner === "foreign") {
      await expect(fixture.coordinator.executeHumanAction(action)).rejects.toMatchObject({
        code: "remote_ownership_operation_conflict"
      });
      expect(fixture.operations.getRequired(operation.id).state).toBe("interrupted");
      return;
    }
    await fixture.coordinator.executeHumanAction(action);
    expect(fixture.operations.getRequired(operation.id).state).toBe("cancelled");
    const runtime = fixture.runtime.query({ ref: operation.blockRef, operationId: operation.id });
    if (owner === "same") {
      await expect(runtime).resolves.toMatchObject({
        terminalReceipt: { outcome: "failed", failure: { code: "execution_cancelled" } }
      });
    } else {
      await expect(runtime).rejects.toMatchObject({ code: "remote_ownership_not_active" });
    }
    await fixture.coordinator.executeHumanAction(action);
    expect(fixture.dispatches.get(operation.dispatchId)).toBeUndefined();
  });

  it("observes an interrupted dispatch without asking an offline Runtime", async () => {
    const fixture = await setup(true);
    if (!fixture.host) throw new Error("expected_test_host");
    const outcome = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.dispatchLocator,
        blockRef: "T-001#B-001",
        idempotencyKey: "observe-interrupted-offline-runtime"
      })
    );
    const operation = fixture.operations.getRequired(outcome.operation.id);
    const dispatch = fixture.dispatches.getRequired(operation.dispatchId);
    fixture.dispatches.accept(
      fixture.host.id,
      "observe-interrupted-accepted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    fixture.dispatches.interrupt(fixture.host.id, "observe-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: agentHostProtocolVersion,
      messageId: "observe-interrupted",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "lease_lost",
      resumable: true,
      recovery: { acpSessionId: "session-observe", recoveryId: "recovery-observe" }
    });
    const reservation = fixture.reservations.getRequired(dispatch.leaseId);
    fixture.reservations.release({
      leaseId: reservation.leaseId,
      fencingToken: reservation.fencingToken,
      expectedVersion: reservation.version,
      reason: "expired"
    });
    await fixture.coordinator.reenter(operation.id);
    const query = vi
      .spyOn(fixture.coordinator, "query")
      .mockRejectedValue(new Error("canvas_runtime_unavailable"));
    const service = new HumanRemoteControlService({
      operations: fixture.operations,
      dispatches: fixture.dispatches,
      coordinator: fixture.coordinator,
      events: fixture.acpEvents,
      interactions: fixture.interactions
    });
    const workspaceId = workspaceIdSchema.parse(fixture.locator.workspaceId);
    const observation = await service.lookupLatestOperation(
      {
        workspaceId,
        projectId: fixture.locator.projectId,
        actor: {
          kind: "workspace_device",
          workspaceId,
          projectId: fixture.locator.projectId,
          deviceSessionId: deviceSessionIdSchema.parse("device-session-test"),
          humanPrincipalId: "human-test",
          displayName: "Test member"
        }
      },
      { canvasId: fixture.locator.canvasId, blockRef: operation.blockRef }
    );
    expect(query).not.toHaveBeenCalled();
    expect(observation).toMatchObject({
      state: "interrupted",
      runtime: {
        status: "interrupted",
        interruption: {
          reason: "lease_lost",
          resumable: true,
          recovery: { acpSessionId: "session-observe", recoveryId: "recovery-observe" }
        }
      }
    });
  });
});
