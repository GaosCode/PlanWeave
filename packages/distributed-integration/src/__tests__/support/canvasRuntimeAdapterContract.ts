import type { CanvasRuntimeAvailabilityPort } from "../../../../server/src/canvas/runtimePort.js";
import type {
  CanvasExecutionRuntimeLease,
  CanvasExecutionRuntimeLeasePort,
  RuntimeCanvasScope
} from "../../../../server/src/canvas/executionRuntimePort.js";
import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import type { CanvasScopeRef } from "../../../../collaboration-protocol/src/primitives.js";
import { describe, expect, it } from "vitest";

export type CanvasRuntimeAdapterContractFixture = {
  scope: CanvasScopeRef & RuntimeCanvasScope;
  blockRef: string;
  adapter: CanvasRuntimeAvailabilityPort & CanvasExecutionRuntimeLeasePort;
  detach(): void | Promise<void>;
  releaseCount(): number;
  inspectReleased(lease: CanvasExecutionRuntimeLease): Promise<unknown>;
  beginMutationThenDetach(
    lease: CanvasExecutionRuntimeLease,
    candidate: RemoteBlockDispatchCandidate
  ): Promise<unknown>;
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
        ).rejects.toMatchObject({ contractOutcome: "content_out_of_sync" });

        await lease.release();
        await lease.release();
        expect(fixture.releaseCount()).toBe(1);
        await expect(fixture.inspectReleased(lease)).rejects.toMatchObject({
          contractOutcome: "runtime_unavailable"
        });

        const pendingLease = await fixture.adapter.acquire(fixture.scope);
        const pendingCandidate = await pendingLease.runtime.inspect({ ref: fixture.blockRef });
        await expect(
          fixture.beginMutationThenDetach(pendingLease, pendingCandidate)
        ).rejects.toMatchObject({ contractOutcome: "reconcile_required" });

        await fixture.detach();
        await expect(fixture.adapter.readAvailability(fixture.scope)).resolves.toMatchObject({
          kind: "unavailable"
        });
        await expect(fixture.adapter.acquire(fixture.scope)).rejects.toMatchObject({
          contractOutcome: "runtime_unavailable"
        });
      } finally {
        await fixture.close();
      }
    });
  });
}

export function contractError(
  contractOutcome: "content_out_of_sync" | "runtime_unavailable" | "reconcile_required"
): Error & { contractOutcome: string } {
  return Object.assign(new Error(contractOutcome), { contractOutcome });
}

export function contractClaimInput(candidate: RemoteBlockDispatchCandidate) {
  return claimInput(candidate, candidate.sourceRevision);
}
