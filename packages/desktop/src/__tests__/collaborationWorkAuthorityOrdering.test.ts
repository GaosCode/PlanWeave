import {
  scopedProjectFixture,
  collaborationOperationScopeFixture
} from "./helpers/collaborationOperationScopeFixture";
/* @vitest-environment jsdom */
import { useMemo } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  exampleAssignmentProjection,
  exampleObserverEvent
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import { CollaborationReadModelController } from "../renderer/collaboration/CollaborationReadModelController";
import { resetCollaborationReadModelHubForTests } from "../renderer/collaboration/collaborationReadModelHub";
import { useCollaborationReadModels } from "../renderer/hooks/useCollaborationReadModels";
import { workItemKey } from "../shared/collaborationReadModels";
import { createMockApi } from "./helpers/collaborationReadModelFixtures";

const workItem = exampleAssignmentProjection.workItem;
const key = workItemKey(workItem);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const f = createMockApi();
  const read = vi.mocked(f.api.getCollaborationWorkAuthority);
  const authorityFor = read.getMockImplementation()!;
  const operationScope = collaborationOperationScopeFixture("profile-demo-001", "project-demo-001");
  const initial = await f.api.getCollaborationWorkAuthority({ workItem, operationScope });
  const authority = {
    ...initial,
    responsibility: { ...initial.responsibility, revision: 3 },
    reviewer: { ...initial.reviewer, revision: 17 }
  };
  read.mockResolvedValue(authority);
  const controller = new CollaborationReadModelController({ api: f.api });
  await controller.setActiveProject({
    operationScope,
    profileId: "profile-demo-001",
    projectId: "project-demo-001",
    canvasId: "canvas-1"
  });
  await controller.ensureWorkAuthority(workItem);
  let observerCursor = 0;
  const run = async (entry: string) => {
    if (entry === "ensure") await controller.ensureWorkAuthority(workItem);
    else if (entry === "aggregate") await controller.refreshAuthoritative();
    else if (entry === "observer") {
      observerCursor += 1;
      f.signalListeners[0]!({
        type: "human.observer.event",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        event: {
          ...exampleObserverEvent,
          cursor: observerCursor,
          previousCursor: observerCursor - 1,
          kind: "assignment",
          workItem
        }
      });
      await vi.waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(observerCursor));
    } else if (entry === "responsibility") {
      vi.mocked(f.api.updateCollaborationResponsibility).mockResolvedValue(
        authority.responsibility
      );
      expect(
        await controller.updateResponsibility({ workItem, principal: null, expectedRevision: 2 })
      ).toEqual(authority.responsibility);
    } else {
      vi.mocked(f.api.updateCollaborationReviewer).mockResolvedValue(authority.reviewer);
      expect(
        await controller.updateReviewer({ workItem, principal: null, expectedRevision: 16 })
      ).toEqual(authority.reviewer);
    }
  };
  return { ...f, controller, read, authority, authorityFor, operationScope, run };
}

describe("work authority request ordering", () => {
  it.each(
    ["members", "assignments", "activity", "comments"].flatMap((reader) =>
      ["resolve", "reject"].map((outcome) => ({ reader, outcome }))
    )
  )("retires aggregate $reader before its late $outcome when changing canvas", async ({
    reader,
    outcome
  }) => {
    const f = await fixture();
    await f.controller.trackWorkItemComments(workItem);
    const read = {
      members: f.listMembers,
      assignments: f.listAssignments,
      activity: f.listActivity,
      comments: f.listComments
    }[reader]!;
    const value = await read();
    const gate = deferred<void>();
    const started = deferred<void>();
    let retired: unknown;
    let nextFinished = false;
    let aggregate: Promise<unknown> | undefined;
    let next: Promise<void> | undefined;
    try {
      read.mockImplementationOnce(async () => {
        started.resolve();
        await gate.promise;
        if (outcome === "reject") throw new Error("retired_read_failed");
        return value;
      });
      aggregate = f.controller.refreshAuthoritative().then((result) => {
        retired = result;
      });
      await started.promise;
      next = f.controller
        .setActiveProject(
          scopedProjectFixture({
            profileId: "profile-demo-001",
            projectId: "project-demo-001",
            canvasId: "canvas-2"
          })
        )
        .then(() => {
          nextFinished = true;
        });
      await vi.waitFor(() => {
        expect(retired).toEqual({ status: "retired" });
        expect(nextFinished).toBe(true);
        expect(f.controller.getSnapshot()).toMatchObject({
          canvasId: "canvas-2",
          syncPhase: "ready",
          loadingKinds: []
        });
      });
      const snapshot = f.controller.getSnapshot();
      gate.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(f.controller.getSnapshot()).toEqual(snapshot);
    } finally {
      gate.resolve();
      await Promise.all([aggregate, next]);
      f.controller.dispose();
    }
  });
  it.each([
    "multi",
    "scope",
    "unrelated"
  ])("aggregate replacement convergence: %s", async (scenario) => {
    const f = await fixture();
    const old = deferred<WorkAuthorityProjection>();
    const b = deferred<WorkAuthorityProjection>();
    const c = deferred<WorkAuthorityProjection>();
    const started = deferred<void>();
    let finished = false;
    try {
      f.read.mockImplementationOnce(() => {
        started.resolve();
        return old.promise;
      });
      const aggregate = f.controller.refreshAuthoritative().then(() => {
        finished = true;
      });
      await started.promise;
      f.read.mockReturnValueOnce(b.promise);
      const successor = f.controller.ensureWorkAuthority(workItem);
      old.resolve(f.authority);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(finished).toBe(false);
      if (scenario === "scope") {
        f.controller.clear();
        await aggregate;
        expect(f.controller.getSnapshot().syncPhase).toBe("idle");
        expect(f.controller.getSnapshot().workAuthorityByWorkItem).toEqual({});
      } else {
        f.read.mockReturnValueOnce(c.promise);
        const last = f.controller.ensureWorkAuthority(
          scenario === "unrelated" ? { ...workItem, canvasId: "unrelated" } : workItem
        );
        b.resolve({
          ...f.authority,
          responsibility: { ...f.authority.responsibility, revision: 2 }
        });
        await successor;
        if (scenario === "multi") {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          expect(finished).toBe(false);
          c.resolve(f.authority);
        }
        await aggregate;
        expect(
          f.controller.getSnapshot().workAuthorityByWorkItem[key]?.responsibility.revision
        ).toBe(scenario === "multi" ? 3 : 2);
        c.resolve(
          await f.authorityFor({
            workItem: { ...workItem, canvasId: "unrelated" },
            operationScope: f.operationScope
          })
        );
        await last;
      }
      b.resolve(f.authority);
      await successor;
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      old.resolve(f.authority);
      b.resolve(f.authority);
      c.resolve(f.authority);
      f.controller.dispose();
    }
  });
  it("registered observer non-authority resource failure remains visible", async () => {
    const f = await fixture();
    try {
      f.listAssignments.mockRejectedValueOnce({
        kind: "offline",
        code: "assignments_failed",
        message: "Assignment read failed",
        retryable: true
      });
      f.signalListeners[0]!({
        type: "human.observer.event",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        event: {
          ...exampleObserverEvent,
          kind: "assignment",
          cursor: 1,
          previousCursor: 0,
          workItem
        }
      });
      await vi.waitFor(() =>
        expect(f.controller.getSnapshot().lastError?.code).toBe("assignments_failed")
      );
      await f.controller.ensureWorkAuthority(workItem);
      expect(f.controller.getSnapshot().lastError?.code).toBe("assignments_failed");
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      f.controller.dispose();
    }
  });

  it.each([
    false,
    true
  ])("registered observer failure recovers without replay (subscriber=%s)", async (subscriber) => {
    const f = await fixture();
    const observed = deferred<void>();
    let newer: Promise<unknown> | undefined;
    let launched = false;
    const error = {
      kind: "offline",
      code: "observer_authority_failed",
      message: "Offline",
      retryable: true
    };
    const unsubscribe = f.controller.subscribe((snapshot) => {
      if (snapshot.lastError?.code !== error.code || launched) return;
      launched = true;
      if (subscriber) newer = f.controller.ensureWorkAuthority(workItem);
      observed.resolve();
    });
    try {
      f.read.mockRejectedValueOnce(error);
      f.signalListeners[0]!({
        type: "human.observer.event",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        event: {
          ...exampleObserverEvent,
          kind: "assignment",
          cursor: 1,
          previousCursor: 0,
          workItem
        }
      });
      await observed.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!subscriber) newer = f.controller.ensureWorkAuthority(workItem);
      await newer;
      expect(f.controller.getSnapshot().workAuthorityByWorkItem[key]?.responsibility.revision).toBe(
        3
      );
      expect(f.controller.getSnapshot().lastError).toBeNull();
      expect(f.controller.getSnapshot().syncPhase).toBe("ready");
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
      // The failed event remains retryable rather than being marked applied.
      const reads = f.read.mock.calls.length;
      f.signalListeners[0]!({
        type: "human.observer.event",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        event: {
          ...exampleObserverEvent,
          kind: "assignment",
          cursor: 1,
          previousCursor: 0,
          workItem
        }
      });
      await vi.waitFor(() => expect(f.controller.getSnapshot().observerCursor).toBe(1));
      expect(f.read.mock.calls.length).toBe(reads + 1);
    } finally {
      unsubscribe();
      f.controller.dispose();
    }
  });
  it.each([
    "responsibility",
    "reviewer"
  ] as const)("aggregate waits for pending replacement %s", async (role) => {
    const f = await fixture();
    const old = deferred<WorkAuthorityProjection>();
    const next = deferred<WorkAuthorityProjection>();
    const started = deferred<void>();
    const initial = { ...f.authority, [role]: { ...f.authority[role], revision: 2 } };
    f.read.mockResolvedValueOnce(initial);
    await f.controller.ensureWorkAuthority(workItem);
    let finished = false;
    try {
      f.read.mockImplementationOnce(() => {
        started.resolve();
        return old.promise;
      });
      const aggregate = f.controller.refreshAuthoritative().then(() => {
        finished = true;
      });
      await started.promise;
      f.read.mockReturnValueOnce(next.promise);
      const replacement = f.controller.ensureWorkAuthority(workItem);
      old.resolve(f.authority);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const premature = finished;
      const phase = f.controller.getSnapshot().syncPhase;
      next.resolve(f.authority);
      await Promise.all([aggregate, replacement]);
      expect(premature).toBe(false);
      expect(phase).toBe("loading");
      expect(f.controller.getSnapshot().workAuthorityByWorkItem[key]).toEqual(f.authority);
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      old.resolve(f.authority);
      next.resolve(f.authority);
      f.controller.dispose();
    }
  });

  it("keeps a current authority aggregate failure incomplete and recovers on newer same-item success", async () => {
    const f = await fixture();
    try {
      f.read.mockRejectedValueOnce({
        kind: "offline",
        code: "current_authority_failed",
        message: "Current failure",
        retryable: true
      });
      await f.controller.refreshAuthoritative();
      expect(f.controller.getSnapshot().lastError?.code).toBe("current_authority_failed");
      expect(f.controller.getSnapshot().syncPhase).toBe("error");
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
      await f.controller.ensureWorkAuthority(workItem);
      expect(f.controller.getSnapshot().lastError).toBeNull();
      expect(f.controller.getSnapshot().syncPhase).toBe("ready");
    } finally {
      f.controller.dispose();
    }
  });
  it("success for another work item cannot clear the current authority error", async () => {
    const f = await fixture();
    try {
      const error = {
        kind: "forbidden",
        code: "current_item_failed",
        message: "Current item failed",
        retryable: false
      };
      f.read.mockRejectedValueOnce(error);
      await expect(f.controller.ensureWorkAuthority(workItem)).rejects.toBe(error);
      const otherItem = { ...workItem, canvasId: "other-canvas" };
      f.read.mockResolvedValueOnce(
        await f.authorityFor({ workItem: otherItem, operationScope: f.operationScope })
      );
      await f.controller.ensureWorkAuthority(otherItem);
      expect(f.controller.getSnapshot().lastError?.code).toBe(error.code);
      expect(f.controller.getSnapshot().syncPhase).toBe("forbidden");
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      f.controller.dispose();
    }
  });
  it.each([
    "latest failure",
    "latest success",
    "current activity failure"
  ])("does not replay retired aggregate authority failure after %s", async (scenario) => {
    const f = await fixture();
    const page = await f.api.listCollaborationActivity({ operationScope: f.operationScope });
    const activity = deferred<typeof page>();
    const observed = deferred<void>();
    const oldError = {
      kind: "offline",
      code: "old_aggregate_failed",
      message: "Old failure",
      retryable: true
    };
    const latestError = {
      kind: "forbidden",
      code: "latest_authority_failed",
      message: "Latest failure",
      retryable: false
    };
    const unsubscribe = f.controller.subscribe((snapshot) => {
      if (snapshot.lastError?.code === oldError.code) observed.resolve();
    });
    try {
      f.listActivity.mockReturnValueOnce(activity.promise);
      f.read.mockRejectedValueOnce(oldError);
      const aggregate = f.controller.refreshAuthoritative();
      await observed.promise;
      if (scenario === "latest failure") {
        f.read.mockRejectedValueOnce(latestError);
        await expect(f.controller.ensureWorkAuthority(workItem)).rejects.toBe(latestError);
        expect(f.controller.getSnapshot().lastError?.code).toBe(latestError.code);
      } else await f.controller.ensureWorkAuthority(workItem);
      if (scenario === "current activity failure")
        activity.reject({
          kind: "offline",
          code: "activity_failed",
          message: "Activity failed",
          retryable: true
        });
      else activity.resolve(page);
      if (scenario === "latest failure")
        await expect(aggregate).resolves.toEqual({ status: "failed", error: latestError });
      else await aggregate;
      expect(f.controller.getSnapshot().lastError?.code ?? null).toBe(
        scenario === "latest failure"
          ? latestError.code
          : scenario === "current activity failure"
            ? "activity_failed"
            : null
      );
      expect(f.controller.getSnapshot().syncPhase).toBe(
        scenario === "latest failure"
          ? "forbidden"
          : scenario === "current activity failure"
            ? "error"
            : "ready"
      );
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      unsubscribe();
      activity.resolve(page);
      f.controller.dispose();
    }
  });
  it.each([
    "ensure",
    "aggregate",
    "observer",
    "responsibility",
    "reviewer"
  ])("%s refresh supersedes older success and failure", async (entry) => {
    const f = await fixture();
    try {
      for (const olderEntry of new Set(["ensure", entry]))
        for (const failure of [false, true]) {
          const old = deferred<WorkAuthorityProjection>();
          f.read.mockReturnValueOnce(old.promise);
          const reads = f.read.mock.calls.length;
          const pending = f.run(olderEntry);
          await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(reads + 1));
          await f.run(olderEntry === "ensure" ? entry : "ensure");
          if (failure)
            old.reject({
              kind: "offline",
              code: "old_failed",
              message: "Old failure",
              retryable: true
            });
          else
            old.resolve({
              ...f.authority,
              responsibility: { ...f.authority.responsibility, revision: 2 }
            });
          await pending;
          expect(f.controller.getSnapshot().workAuthorityByWorkItem[key]).toEqual(f.authority);
          expect(f.controller.getSnapshot().lastError).toBeNull();
          expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
        }
    } finally {
      f.controller.dispose();
    }
  });
  it("an older aggregate cannot clear a newer authority error", async () => {
    const f = await fixture();
    const old = deferred<WorkAuthorityProjection>();
    try {
      f.read.mockReturnValueOnce(old.promise);
      const aggregate = f.controller.refreshAuthoritative();
      await vi.waitFor(() =>
        expect(f.controller.getSnapshot().loadingKinds).toContain(`authority:${key}`)
      );
      f.read.mockRejectedValueOnce({
        kind: "offline",
        code: "latest_failed",
        message: "Latest failed",
        retryable: true
      });
      await expect(f.controller.ensureWorkAuthority(workItem)).rejects.toMatchObject({
        code: "latest_failed"
      });
      old.resolve(f.authority);
      await expect(aggregate).resolves.toMatchObject({
        status: "failed",
        error: { code: "latest_failed" }
      });
      expect(f.controller.getSnapshot().lastError?.code).toBe("latest_failed");
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      old.resolve(f.authority);
      f.controller.dispose();
    }
  });
  it.each([
    "success",
    "failure"
  ])("retired scope ignores old %s and releases leases", async (outcome) => {
    const f = await fixture();
    const gate = deferred<WorkAuthorityProjection>();
    try {
      f.read.mockReturnValueOnce(gate.promise);
      let retired = false;
      const pending = f.controller.ensureWorkAuthority(workItem).then((value) => {
        retired = true;
        return value;
      });
      f.controller.clear();
      await f.controller.setActiveProject(
        scopedProjectFixture({ profileId: "profile-new", projectId: "project-new" })
      );
      await vi.waitFor(() => expect(retired).toBe(true));
      expect(await pending).toBeNull();
      if (outcome === "success") gate.resolve(f.authority);
      else gate.reject(new Error("retired_failed"));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(f.controller.getSnapshot().workAuthorityByWorkItem).toEqual({});
      expect(f.controller.getSnapshot().lastError).toBeNull();
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      gate.resolve(f.authority);
      f.controller.dispose();
    }
  });
  it.each([
    "canvas",
    "project"
  ])("managing hook refreshes a new %s while the old authority request stays pending", async (scope) => {
    const f = createMockApi();
    const read = vi.mocked(f.api.getCollaborationWorkAuthority);
    const authority = await f.api.getCollaborationWorkAuthority({
      workItem,
      operationScope: collaborationOperationScopeFixture("profile-demo-001", "project-demo-001")
    });
    const old = deferred<WorkAuthorityProjection>();
    const started = deferred<void>();
    const hook = renderHook(
      (props) => {
        const operationScope = useMemo(
          () => collaborationOperationScopeFixture(props.profileId, props.projectId),
          [props.profileId, props.projectId]
        );
        return useCollaborationReadModels({
          ...props,
          operationScope,
          api: f.api,
          manageActiveProject: true
        });
      },
      {
        initialProps: {
          profileId: "profile-demo-001",
          projectId: "project-demo-001",
          canvasId: "canvas-1"
        }
      }
    );
    let aggregate: Promise<unknown> | undefined;
    let aggregateFinished = false;
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
      await act(async () => {
        aggregate = controller.refreshAuthoritative().then((result) => {
          aggregateFinished = true;
          return result;
        });
        await started.promise;
      });
      const memberReads = f.listMembers.mock.calls.length;
      const nextScope = {
        profileId: scope === "project" ? "profile-new" : "profile-demo-001",
        projectId: scope === "project" ? "project-new" : "project-demo-001",
        canvasId: "canvas-2"
      };
      act(() => hook.rerender(nextScope));
      await waitFor(() => {
        expect(hook.result.current.snapshot).toMatchObject({ ...nextScope, syncPhase: "ready" });
        expect(aggregateFinished).toBe(true);
      });
      expect(hook.result.current.controller).toBe(controller);
      expect(f.listMembers.mock.calls.length).toBeGreaterThan(memberReads);
      expect(hook.result.current.snapshot.loadingKinds).toEqual([]);
      const latestAuthorities = hook.result.current.snapshot.workAuthorityByWorkItem;
      await act(async () => {
        if (scope === "canvas") old.resolve(authority);
        else old.reject(new Error("retired_authority_failed"));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(hook.result.current.snapshot.workAuthorityByWorkItem).toEqual(latestAuthorities);
      expect(hook.result.current.snapshot.lastError).toBeNull();
      expect(hook.result.current.snapshot.loadingKinds).toEqual([]);
    } finally {
      old.resolve(authority);
      await aggregate;
      hook.unmount();
      resetCollaborationReadModelHubForTests();
    }
  });
  it.each([
    "responsibility",
    "reviewer"
  ] as const)("%s mutation success survives latest confirmation refresh error", async (role) => {
    const f = await fixture();
    try {
      f.read.mockRejectedValueOnce({
        kind: "offline",
        code: "confirmation_failed",
        message: "Refresh failed",
        retryable: true
      });
      await f.run(role);
      expect(f.controller.getSnapshot().lastError?.code).toBe("confirmation_failed");
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
      expect(Object.values(f.controller.getSnapshot().mutationsById)).toEqual([
        expect.objectContaining({ status: "confirmed" })
      ]);
    } finally {
      f.controller.dispose();
    }
  });
});
