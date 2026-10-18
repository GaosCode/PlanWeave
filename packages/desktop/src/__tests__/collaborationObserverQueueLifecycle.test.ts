import { scopedProjectFixture } from "./helpers/collaborationOperationScopeFixture";
/* @vitest-environment jsdom */

import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { humanObserverEventSchema } from "@planweave-ai/collaboration-protocol/activity/observer";
import {
  exampleAssignmentProjection,
  exampleCommentListPage,
  exampleCommentProjection,
  exampleObserverEvent
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { CollaborationReadModelController } from "../renderer/collaboration/CollaborationReadModelController";
import type { CollaborationObserverSignal } from "../shared/collaboration";
import { workItemKey } from "../shared/collaborationReadModels";
import { createMockApi } from "./helpers/collaborationReadModelFixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function item(canvasId: string, index = 1): WorkItemRef {
  return { kind: "block", canvasId, blockRef: `task-1#B-${String(index).padStart(3, "0")}` };
}

function comments(workItem: WorkItemRef, revision: number) {
  return {
    ...exampleCommentListPage,
    items: [{ ...exampleCommentProjection, workItem, revision, body: `revision ${revision}` }]
  };
}

function event(
  cursor: number,
  workItem: WorkItemRef,
  kind: "comment" | "attachment" | "assignment",
  profileId = "profile-demo-001",
  projectId = "project-demo-001"
): CollaborationObserverSignal {
  return {
    type: "human.observer.event",
    profileId,
    projectId,
    event: humanObserverEventSchema.parse({
      ...exampleObserverEvent,
      kind,
      cursor,
      previousCursor: cursor - 1,
      workItem
    })
  };
}

describe("collaboration observer queue generation lifecycle", () => {
  it.each([
    { transition: "canvas", kind: "comment", outcome: "resolve" },
    { transition: "canvas", kind: "attachment", outcome: "reject" },
    { transition: "canvas", kind: "assignment", outcome: "reject" },
    { transition: "project", kind: "comment", outcome: "reject" },
    { transition: "profile", kind: "attachment", outcome: "resolve" },
    { transition: "catchup", kind: "comment", outcome: "resolve" },
    { transition: "clear", kind: "attachment", outcome: "reject" }
  ] as const)("applies $kind after $transition before four retired reads $outcome", async ({
    transition,
    kind,
    outcome
  }) => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    const oldReads = Array.from({ length: 4 }, () => deferred<void>());
    let holdingOldReads = true;
    let oldStarted = 0;
    let newRevision = 1;
    const nextItem = item(
      transition === "catchup" || transition === "clear" ? "canvas-1" : "canvas-2"
    );
    mock.listComments.mockImplementation(({ workItem }: { workItem: WorkItemRef }) => {
      if (holdingOldReads) {
        const read = oldReads[oldStarted++];
        if (!read) throw new Error("queued retired event must not start");
        return read.promise.then(() => comments(workItem, 999));
      }
      return Promise.resolve(comments(workItem, newRevision));
    });
    if (kind === "assignment") {
      mock.listAssignments.mockImplementation(
        ({ workItems, canvasId }: { workItems?: WorkItemRef[]; canvasId?: string }) => {
          const workItem = workItems?.[0] ?? item(canvasId ?? "canvas-1");
          const page = (revision: number) => ({
            items: [{ ...exampleAssignmentProjection, workItem, revision }],
            nextCursor: null
          });
          if (workItems && holdingOldReads) {
            const read = oldReads[oldStarted++];
            if (!read) throw new Error("queued retired assignment must not start");
            return read.promise.then(() => page(999));
          }
          return Promise.resolve(page(newRevision));
        }
      );
    }
    const nextRevision = () => {
      const snapshot = controller.getSnapshot();
      return kind === "assignment"
        ? snapshot.assignmentsByWorkItem[workItemKey(nextItem)]?.revision
        : snapshot.commentsByWorkItem[workItemKey(nextItem)]?.[0]?.revision;
    };
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        canvasId: "canvas-1"
      })
    );
    const oldObserver = mock.signalListeners[0]!;
    let stopObservingSettlement: (() => void) | undefined;
    try {
      for (let cursor = 1; cursor <= 4; cursor += 1) {
        oldObserver(event(cursor, item("canvas-1", cursor), kind));
      }
      oldObserver(event(90, item("canvas-1", 90), kind));
      expect(oldStarted).toBe(4);
      expect(controller.getSnapshot().observerCursor).toBe(0);
      holdingOldReads = false;
      const profileId = transition === "profile" ? "profile-next" : "profile-demo-001";
      const projectId = transition === "project" ? "project-next" : "project-demo-001";
      if (transition === "catchup") {
        oldObserver({
          type: "human.observer.catchup_required",
          profileId,
          projectId,
          reason: "reset",
          resumeCursor: 0
        });
        await waitFor(() => expect(controller.getSnapshot().syncPhase).toBe("ready"));
      } else {
        if (transition === "clear") controller.clear();
        await controller.setActiveProject(
          scopedProjectFixture({ profileId, projectId, canvasId: nextItem.canvasId })
        );
      }
      await controller.trackWorkItemComments(nextItem);
      expect(nextRevision()).toBe(1);
      expect(controller.getSnapshot().observerCursor).toBe(0);
      newRevision = 2;
      mock.signalListeners[0]!(event(90, nextItem, kind, profileId, projectId));

      await waitFor(() => {
        expect(nextRevision()).toBe(2);
        expect(controller.getSnapshot().observerCursor).toBe(90);
      });
      expect(oldStarted).toBe(4);
      expect(
        mock.listComments.mock.calls.some(([query]) => query.workItem.blockRef === "task-1#B-090")
      ).toBe(false);
      expect(
        mock.listAssignments.mock.calls.some(([query]) =>
          query.workItems?.some(
            (workItem: WorkItemRef) =>
              workItem.kind === "block" && workItem.blockRef === "task-1#B-090"
          )
        )
      ).toBe(false);
      let observedRetiredPollution = false;
      stopObservingSettlement = controller.subscribe((snapshot) => {
        if (nextRevision() !== 2 || snapshot.observerCursor !== 90 || snapshot.lastError !== null) {
          observedRetiredPollution = true;
        }
      });
      for (const read of oldReads) {
        if (outcome === "resolve") read.resolve();
        else read.reject(new Error("retired observer read failed"));
      }
      await Promise.allSettled(oldReads.map((read) => read.promise));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(nextRevision()).toBe(2);
      expect(controller.getSnapshot().observerCursor).toBe(90);
      expect(controller.getSnapshot().lastError).toBeNull();
      expect(controller.getSnapshot().loadingKinds).toEqual([]);
      expect(observedRetiredPollution).toBe(false);
      await controller.refreshAuthoritative({ reason: "verify_after_retired_settlement" });
      const snapshot = controller.getSnapshot();
      expect(nextRevision()).toBe(2);
      expect(snapshot.observerCursor).toBe(90);
      expect(snapshot.lastError).toBeNull();
      expect(snapshot.loadingKinds).toEqual([]);
      expect(snapshot.syncPhase).toBe("ready");
      expect(oldStarted).toBe(4);
      expect(observedRetiredPollution).toBe(false);
    } finally {
      stopObservingSettlement?.();
      for (const read of oldReads) read.resolve();
      controller.dispose();
      await Promise.allSettled(oldReads.map((read) => read.promise));
    }
  });

  it("keeps the replacement generation at four active reads when old finally handlers settle", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    const oldReads = Array.from({ length: 4 }, () => deferred<typeof exampleCommentListPage>());
    const newReads = Array.from({ length: 5 }, () => deferred<typeof exampleCommentListPage>());
    let oldStarted = 0;
    let newStarted = 0;
    let newActive = 0;
    let newPeak = 0;
    mock.listComments.mockImplementation(async ({ workItem }: { workItem: WorkItemRef }) => {
      if (workItem.canvasId === "canvas-1") {
        return oldReads[oldStarted++]!.promise;
      }
      newActive += 1;
      newPeak = Math.max(newPeak, newActive);
      const read = newReads[newStarted++];
      if (!read) throw new Error("duplicate cursor started an extra read");
      try {
        return await read.promise;
      } finally {
        newActive -= 1;
      }
    });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        canvasId: "canvas-1"
      })
    );
    try {
      for (let cursor = 1; cursor <= 4; cursor += 1) {
        mock.signalListeners[0]!(event(cursor, item("canvas-1", cursor), "comment"));
      }
      expect(oldStarted).toBe(4);
      await controller.setActiveProject(
        scopedProjectFixture({
          profileId: "profile-demo-001",
          projectId: "project-demo-001",
          canvasId: "canvas-2"
        })
      );
      for (let cursor = 101; cursor <= 105; cursor += 1) {
        const signal = event(cursor, item("canvas-2", cursor), "attachment");
        mock.signalListeners[0]!(signal);
        mock.signalListeners[0]!(signal);
      }
      expect(newStarted).toBe(4);
      for (const read of oldReads) read.resolve(exampleCommentListPage);
      await Promise.all(oldReads.map((read) => read.promise));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(newStarted).toBe(4);
      expect(newPeak).toBe(4);
      newReads[0]!.resolve(comments(item("canvas-2", 101), 2));
      await waitFor(() => expect(newStarted).toBe(5));
      for (let index = 1; index < 5; index += 1) {
        newReads[index]!.resolve(comments(item("canvas-2", index + 101), 2));
      }
      await waitFor(() => {
        const snapshot = controller.getSnapshot();
        expect(snapshot.observerCursor).toBe(105);
        expect(snapshot.loadingKinds).toEqual([]);
        for (let cursor = 101; cursor <= 105; cursor += 1) {
          expect(
            snapshot.commentsByWorkItem[workItemKey(item("canvas-2", cursor))]?.[0]?.revision
          ).toBe(2);
        }
      });
      expect(newPeak).toBe(4);
      expect(newStarted).toBe(5);
      expect(controller.getSnapshot().lastError).toBeNull();
    } finally {
      for (const read of [...oldReads, ...newReads]) read.resolve(exampleCommentListPage);
      controller.dispose();
      await Promise.allSettled([...oldReads, ...newReads].map((read) => read.promise));
    }
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("does not finish a catchup replacement attempt when the old cursor read %s", async (outcome) => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    const oldRead = deferred<typeof exampleCommentListPage>();
    const newRead = deferred<typeof exampleCommentListPage>();
    const workItem = item("canvas-1");
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        canvasId: "canvas-1"
      })
    );
    mock.listComments
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValueOnce(comments(workItem, 1))
      .mockReturnValue(newRead.promise);
    const observer = mock.signalListeners[0]!;
    try {
      observer(event(1, workItem, "comment"));
      expect(mock.listComments).toHaveBeenCalledTimes(1);
      observer({
        type: "human.observer.catchup_required",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        reason: "reset",
        resumeCursor: 0
      });
      await waitFor(() => expect(controller.getSnapshot().syncPhase).toBe("ready"));
      observer(event(1, workItem, "attachment"));
      expect(mock.listComments).toHaveBeenCalledTimes(3);
      if (outcome === "resolve") oldRead.resolve(comments(workItem, 999));
      else oldRead.reject(new Error("retired cursor read failed"));
      await Promise.allSettled([oldRead.promise]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(controller.getSnapshot().observerCursor).toBe(0);
      expect(controller.getSnapshot().lastError).toBeNull();
      observer(event(1, workItem, "attachment"));
      newRead.resolve(comments(workItem, 2));
      await waitFor(() => {
        expect(controller.getSnapshot().observerCursor).toBe(1);
        expect(
          controller.getSnapshot().commentsByWorkItem[workItemKey(workItem)]?.[0]?.revision
        ).toBe(2);
        expect(controller.getSnapshot().loadingKinds).toEqual([]);
      });
      expect(mock.listComments).toHaveBeenCalledTimes(3);
      expect(controller.getSnapshot().lastError).toBeNull();
    } finally {
      oldRead.resolve(exampleCommentListPage);
      newRead.resolve(exampleCommentListPage);
      controller.dispose();
      await Promise.allSettled([oldRead.promise, newRead.promise]);
    }
  });
});
