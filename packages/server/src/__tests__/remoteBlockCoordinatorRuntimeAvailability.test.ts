import { describe, expect, it } from "vitest";
import { CanvasRuntimeUnavailableError } from "../canvas/executionRuntimePort.js";
import { seedLegacyRemoteOperation } from "./support/legacyRemoteOperationSeed.js";
import { setup } from "./support/remoteBlockCoordinatorFixture.js";

describe("RemoteBlockCoordinator Runtime availability reentry", () => {
  it.each([
    "host_offline",
    "runtime_not_attached"
  ] as const)("keeps an operation awaiting_host when Runtime acquisition reports %s", async (reason) => {
    const fixture = await setup(false);
    const candidate = await fixture.registry.resolve(fixture.locator).inspect({
      ref: "T-001#B-001"
    });
    const operation = seedLegacyRemoteOperation({
      database: fixture.server.database,
      operations: fixture.operations,
      locator: fixture.locator,
      candidate,
      idempotencyKey: `runtime-unavailable-${reason}`,
      hostSelection: {
        workspaceId: fixture.locator.workspaceId,
        assignmentRevision: 0,
        target: { kind: "automatic_host" },
        selection: "automatic",
        requiredCapabilities: candidate.requiredCapabilities
      }
    });
    fixture.registry.setScopedResolver(async () => {
      throw new CanvasRuntimeUnavailableError(reason);
    });

    const [outcome] = await fixture.coordinator.reenterPending();

    expect(outcome?.status).toBe("awaiting_host");
    expect(fixture.operations.latestDiagnostic(operation.id)).toEqual({
      stage: "preparing_runtime",
      error: { code: reason, retryable: true }
    });
  });
});
