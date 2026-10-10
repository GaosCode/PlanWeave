import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeStateSchema } from "../../../runtime/src/schema/runtimeState.js";
import {
  createTimingFixture,
  deferred,
  evidence,
  waitUntilResolved
} from "./support/canvasRuntimeTimingFixture.js";

const writing = vi.hoisted(() => ({
  target: undefined as string | undefined,
  ref: undefined as string | undefined,
  operationId: undefined as string | undefined,
  afterCommit: undefined as (() => Promise<void>) | undefined
}));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (String(args[1]) === writing.target) {
        const state = runtimeStateSchema.parse(JSON.parse(await actual.readFile(args[1], "utf8")));
        if (
          writing.ref !== undefined &&
          state.blocks[writing.ref]?.remoteOwnership?.operationId === writing.operationId
        ) {
          writing.target = undefined;
          await writing.afterCommit?.();
        }
      }
    }
  };
});
afterEach(() => {
  writing.target = undefined;
  writing.ref = undefined;
  writing.operationId = undefined;
  writing.afterCommit = undefined;
});

describe("Canvas Runtime committed write lane", () => {
  it("holds the lane through the real write settle after cancellation and only then admits a lease write", async () => {
    const fixture = await createTimingFixture({ firstPhase: "ready" });
    const committed = deferred();
    const finish = deferred();
    writing.target = fixture.canvas.stateFile;
    writing.afterCommit = async () => {
      committed.resolve();
      await finish.promise;
    };
    const identity = fixture.firstIdentity;
    writing.ref = identity.ref;
    writing.operationId = identity.operationId;
    const first = fixture.command(
      {
        operation: "claim",
        runtimeLeaseId: fixture.lease.runtimeLeaseId,
        evidence: evidence(identity),
        input: { ref: identity.ref, ...evidence(identity), controlPlane: identity.controlPlane }
      },
      "request-writing"
    );
    fixture.receive(first);
    const firstRun = fixture.service.handle(first);
    await committed.promise;
    const committedState = runtimeStateSchema.parse(
      JSON.parse(await readFile(fixture.canvas.stateFile, "utf8"))
    );
    expect(committedState.blocks[identity.ref]?.remoteOwnership).toMatchObject({
      phase: "preparing",
      operationId: identity.operationId
    });
    await fixture.invalidate("cancel", first.requestId);
    expect(fixture.response(`cancel-${first.requestId}`)).toMatchObject({
      response: { outcome: "success", result: { cancelled: true } }
    });
    const third = fixture.command(
      { operation: "release", runtimeLeaseId: fixture.lease.runtimeLeaseId },
      "request-after-write"
    );
    fixture.receive(third);
    const thirdRun = fixture.service.handle(third);
    await waitUntilResolved(fixture, 3);
    expect(fixture.response(first.requestId)).toBeUndefined();
    expect(fixture.response(third.requestId)).toBeUndefined();
    expect(fixture.state.canvasRuntime.lease(fixture.lease.runtimeLeaseId)).toEqual(fixture.lease);
    finish.resolve();
    await Promise.all([firstRun, thirdRun]);
    expect(fixture.response(first.requestId)).toMatchObject({
      response: {
        outcome: "error",
        error: { code: "reconcile_required", retryable: true, reconcileRequired: true }
      }
    });
    expect(fixture.response(third.requestId)).toMatchObject({
      response: { outcome: "success", operation: "release", result: { released: true } }
    });
    expect(fixture.state.canvasRuntime.lease(fixture.lease.runtimeLeaseId)).toEqual({
      ...fixture.lease,
      status: "released"
    });
    expect((await fixture.snapshot()).state.blocks[identity.ref]?.remoteOwnership).toMatchObject({
      phase: "preparing",
      operationId: identity.operationId
    });
  });
});
