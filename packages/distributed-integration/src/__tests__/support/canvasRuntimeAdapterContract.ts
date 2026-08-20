import type { CanvasRuntimeAvailabilityPort } from "../../../../server/src/canvas/runtimePort.js";
import type {
  CanvasExecutionRuntimeLeasePort,
  RuntimeCanvasScope
} from "../../../../server/src/canvas/executionRuntimePort.js";
import type { CanvasScopeRef } from "../../../../collaboration-protocol/src/primitives.js";
import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";

export type CanvasRuntimeAdapterContractFixture = {
  scope: CanvasScopeRef & RuntimeCanvasScope;
  blockRef: string;
  adapter: CanvasRuntimeAvailabilityPort & CanvasExecutionRuntimeLeasePort;
  detach(): void | Promise<void>;
  releaseDelegateCalls(): number;
  sourceDriftError: Readonly<Record<string, unknown>>;
  unavailableAcquireError: Readonly<Record<string, unknown>>;
  close(): void | Promise<void>;
};

export type CanvasRuntimeAdapterContractFactory = {
  name: string;
  create(): Promise<CanvasRuntimeAdapterContractFixture>;
};

function changedSourceRevision(sourceRevision: string): string {
  return sourceRevision === "snapshot:contract-drift"
    ? "snapshot:contract-other"
    : "snapshot:contract-drift";
}

function claimInput(candidate: RemoteBlockDispatchCandidate, sourceRevision: string) {
  return {
    ref: candidate.blockRef,
    operationId: "operation-contract-claim",
    controlPlane: "collaboration" as const,
    sourceRevision,
    graphFingerprint: candidate.graphFingerprint
  };
}

export function registerCanvasRuntimeAdapterContract(
  factories: readonly CanvasRuntimeAdapterContractFactory[]
): void {
  describe.each(factories)("$name Canvas Runtime adapter contract", ({ create }) => {
    it("shares availability, evidence, drift, release and detach semantics", async () => {
      const fixture = await create();
      try {
        const availability = await fixture.adapter.readAvailability(fixture.scope);
        expect(availability).toMatchObject({ kind: "available", status: { scope: fixture.scope } });
        if (availability.kind !== "available") throw new Error("contract_runtime_unavailable");

        const lease = await fixture.adapter.acquire(fixture.scope);
        const candidate = await lease.runtime.inspect({ ref: fixture.blockRef });
        expect(candidate).toMatchObject({
          workspaceId: fixture.scope.workspaceId,
          projectId: fixture.scope.projectId,
          canvasId: fixture.scope.canvasId,
          blockRef: fixture.blockRef
        });
        expect(candidate.sourceRevision.length).toBeGreaterThan(0);
        expect(candidate.graphFingerprint.length).toBeGreaterThan(0);

        await expect(
          lease.runtime.claim(
            claimInput(candidate, changedSourceRevision(candidate.sourceRevision))
          )
        ).rejects.toMatchObject(fixture.sourceDriftError);

        await lease.release();
        await lease.release();
        expect(fixture.releaseDelegateCalls()).toBe(1);

        await fixture.detach();
        await expect(fixture.adapter.readAvailability(fixture.scope)).resolves.toMatchObject({
          kind: "unavailable"
        });
        await expect(fixture.adapter.acquire(fixture.scope)).rejects.toMatchObject(
          fixture.unavailableAcquireError
        );
      } finally {
        await fixture.close();
      }
    });
  });
}
