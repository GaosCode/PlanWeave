import { describe, expect, it, vi } from "vitest";
import {
  deviceSessionIdSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { HumanRemoteControlService } from "../humanRemoteControlService.js";
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
});
