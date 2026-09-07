import { describe, expect, it, vi } from "vitest";
import {
  deviceSessionIdSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { HumanRemoteControlService } from "../humanRemoteControlService.js";
import { setup } from "./support/remoteBlockCoordinatorFixture.js";

describe("Human observation before remote dispatch", () => {
  it("looks up an expired preparation without querying nonexistent Runtime ownership", async () => {
    const fixture = await setup(true);
    const operation = fixture.operations.create({
      ...fixture.locator,
      blockRef: "T-001#B-001",
      ownershipGeneration: "1",
      idempotencyKey: "interrupted-before-runtime-claim",
      sourceFingerprint: "a".repeat(64),
      requiredCapabilities: ["acp.codex"]
    });
    const reservation = fixture.reservations.reserve(operation.id, {
      agentId: "codex",
      agentProfileId: "codex-acp"
    });
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
  });
});
