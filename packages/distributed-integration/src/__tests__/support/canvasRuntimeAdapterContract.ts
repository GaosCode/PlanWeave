import type { CanvasRuntimeAuthorityAvailabilityPort } from "../../../../server/src/canvas/runtimePort.js";
import type { RuntimeReadAuthority } from "../../../../server/src/canvas/runtimeAuthorityCandidates.js";
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
  authority: RuntimeReadAuthority;
  adapter: CanvasRuntimeAuthorityAvailabilityPort & CanvasExecutionRuntimeLeasePort;
  detach(): void | Promise<void>;
  releaseDelegateCalls(): number;
  sourceDriftError: Readonly<Record<string, unknown>>;
  resetDriftError: Readonly<Record<string, unknown>>;
  unavailableAcquireError: Readonly<Record<string, unknown>>;
  close(): void | Promise<void>;
};

export type CanvasRuntimeAdapterContractFactory = {
  name: string;
  create(): Promise<CanvasRuntimeAdapterContractFixture>;
};

function claimWithChangedAuthority(candidate: RemoteBlockDispatchCandidate) {
  const snapshotDomain = candidate.sourceRevision.startsWith("snapshot:");
  return {
    ref: candidate.blockRef,
    operationId: "operation-contract-claim",
    controlPlane: "collaboration" as const,
    sourceRevision: snapshotDomain ? candidate.sourceRevision : "src-contract-drift",
    graphFingerprint: snapshotDomain ? `pkg-${"f".repeat(64)}` : candidate.graphFingerprint
  };
}

export function registerCanvasRuntimeAdapterContract(
  factories: readonly CanvasRuntimeAdapterContractFactory[]
): void {
  describe.each(factories)("$name Canvas Runtime adapter contract", ({ create }) => {
    it("shares availability, evidence, drift, release and detach semantics", async () => {
      const fixture = await create();
      try {
        const availability = await fixture.adapter.readAvailabilityForAuthority(
          fixture.scope,
          undefined,
          fixture.authority
        );
        expect(availability).toMatchObject({ kind: "available", status: { scope: fixture.scope } });
        if (availability.kind !== "available") throw new Error("contract_runtime_unavailable");
        const mismatchedAuthorities = [
          {
            ...fixture.authority,
            sourceRevision: `snapshot:${"f".repeat(64)}`
          },
          {
            ...fixture.authority,
            target: {
              ...fixture.authority.target,
              graphFingerprint: `pkg-${"f".repeat(64)}`
            }
          }
        ];
        for (const authority of mismatchedAuthorities) {
          await expect(
            fixture.adapter.readAvailabilityForAuthority(fixture.scope, undefined, authority)
          ).resolves.toMatchObject({ kind: "unavailable", reason: "content_out_of_sync" });
        }

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
          lease.runtime.claim(claimWithChangedAuthority(candidate))
        ).rejects.toMatchObject(fixture.sourceDriftError);

        if (!lease.reset) throw new Error("contract_runtime_reset_unavailable");
        await expect(
          lease.reset({
            operationId: "operation-contract-reset-drift",
            expectedSourceRevision: availability.sourceRevision,
            expectedGraphFingerprint: `pkg-${"f".repeat(64)}`
          })
        ).rejects.toMatchObject(fixture.resetDriftError);
        const reset = await lease.reset({
          operationId: "operation-contract-reset",
          expectedSourceRevision: availability.sourceRevision,
          expectedGraphFingerprint: availability.graphFingerprint,
          reason: "Canvas Runtime adapter contract reset."
        });
        expect(reset).toMatchObject({
          operationId: "operation-contract-reset",
          sourceRevision: availability.sourceRevision,
          graphFingerprint: availability.graphFingerprint,
          status: { scope: fixture.scope, packageFingerprint: availability.graphFingerprint }
        });

        await lease.release();
        await lease.release();
        expect(fixture.releaseDelegateCalls()).toBe(1);

        await fixture.detach();
        await expect(
          fixture.adapter.readAvailabilityForAuthority(fixture.scope, undefined, fixture.authority)
        ).resolves.toMatchObject({ kind: "unavailable" });
        await expect(fixture.adapter.acquire(fixture.scope)).rejects.toMatchObject(
          fixture.unavailableAcquireError
        );
      } finally {
        await fixture.close();
      }
    });
  });
}
