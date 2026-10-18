/* @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { exampleAssignmentProjection } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import { useCollaborationReadModels } from "../renderer/hooks/useCollaborationReadModels";
import { createMockApi } from "./helpers/collaborationReadModelFixtures";
import { collaborationOperationScopeFixture } from "./helpers/collaborationOperationScopeFixture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("keeps active-project hook refresh failure diagnostic without an unhandled rejection", async () => {
  const f = createMockApi();
  const workItem = exampleAssignmentProjection.workItem;
  const operationScope = collaborationOperationScopeFixture("profile-demo-001", "project-demo-001");
  const authority = await f.api.getCollaborationWorkAuthority({ workItem, operationScope });
  const read = vi.mocked(f.api.getCollaborationWorkAuthority);
  const old = deferred<WorkAuthorityProjection>();
  const successor = deferred<WorkAuthorityProjection>();
  const started = deferred<void>();
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  const hook = renderHook(
    ({ canvasId }) =>
      useCollaborationReadModels({
        api: f.api,
        operationScope,
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        canvasId,
        manageActiveProject: true
      }),
    { initialProps: { canvasId: "canvas-1" } }
  );
  try {
    await waitFor(() => expect(hook.result.current.snapshot.syncPhase).toBe("ready"));
    const controller = hook.result.current.controller!;
    await act(async () => {
      await controller.ensureWorkAuthority(workItem);
    });
    read.mockImplementationOnce(() => {
      started.resolve();
      return old.promise;
    });
    hook.rerender({ canvasId: "canvas-2" });
    await started.promise;
    read.mockReturnValueOnce(successor.promise);
    const latest = controller.ensureWorkAuthority(workItem).catch((error: unknown) => error);
    const error = { kind: "offline", code: "latest_failed", message: "offline", retryable: true };
    await act(async () => {
      old.resolve(authority);
      successor.reject(error);
      expect(await latest).toBe(error);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(hook.result.current.snapshot.lastError?.code).toBe("latest_failed");
    expect(hook.result.current.snapshot.loadingKinds).toEqual([]);
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    old.resolve(authority);
    successor.resolve(authority);
    hook.unmount();
    process.off("unhandledRejection", unhandled);
  }
});
