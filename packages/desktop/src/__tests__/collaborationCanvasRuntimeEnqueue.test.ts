import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationCanvasOperationsFacade } from "../main/collaboration/CollaborationCanvasOperationsFacade.js";
import { WorkspaceCanvasSession } from "../main/collaboration/WorkspaceCanvasSession.js";

const locator = {
  kind: "workspace" as const,
  connectionProfileId: "profile-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "default"
};

const binding = {
  kind: "remote" as const,
  workspaceId: locator.workspaceId,
  projectId: locator.projectId,
  canvasId: locator.canvasId
};

const availability = {
  schemaVersion: "canvas-runtime-view/v1" as const,
  state: { kind: "uninitialized" as const },
  execution: {
    schemaVersion: "canvas-runtime-availability/v1" as const,
    kind: "unavailable" as const,
    reason: "host_offline" as const
  }
};

const resetOutcome = {
  type: "canvas.runtime.reset.rejected" as const,
  operationId: "reset-1",
  code: "host_offline" as const
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collaboration canvas runtime enqueue isolation", () => {
  it("reads and resets runtime without waiting on the global collaboration queue", async () => {
    const blocked = deferred<void>();
    const enqueue = vi.fn(async (operation: () => Promise<unknown>) => {
      await blocked.promise;
      return operation();
    });
    const readRuntimeAvailability = vi.fn(async () => availability);
    const facade = new CollaborationCanvasOperationsFacade({
      enqueue,
      assertOpen: () => undefined,
      commands: {
        bind: vi.fn(),
        submit: vi.fn(),
        reconnect: vi.fn(),
        projectionForBinding: vi.fn(),
        session: vi.fn(),
        releaseBinding: vi.fn(),
        flushMaterialization: vi.fn()
      } as never,
      runtimeAvailability: { readRuntimeAvailability } as never,
      contentVersions: { listWorkspaceCanvasSharingCandidates: vi.fn() } as never,
      resolveConnectedProfileId: () => "profile-1",
      resolveSnapshotCacheKey: vi.fn(),
      snapshotCache: { get: vi.fn() }
    });
    vi.spyOn(WorkspaceCanvasSession.prototype, "resetRuntime").mockResolvedValue(resetOutcome);

    const stuckOpen = facade.openWorkspaceCanvasSession(locator);
    await expect(facade.readRuntimeAvailability(binding)).resolves.toEqual(availability);
    await expect(
      facade.resetWorkspaceRuntime({
        locator,
        operationId: "reset-1",
        expectedSourceRevision: `snapshot:${"b".repeat(64)}`,
        expectedGraphFingerprint: `pkg-${"a".repeat(64)}`
      })
    ).resolves.toEqual(resetOutcome);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(readRuntimeAvailability).toHaveBeenCalledWith(binding);
    blocked.resolve();
    await expect(stuckOpen).rejects.toThrow();
  });
});
