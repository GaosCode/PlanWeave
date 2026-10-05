/* @vitest-environment jsdom */

import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exampleAssignmentProjection,
  exampleCommentListPage,
  exampleCommentProjection,
  exampleObserverCatchupRequired,
  exampleObserverEvent
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { CollaborationReadModelController } from "../renderer/collaboration/CollaborationReadModelController";
import { workItemKey } from "../shared/collaborationReadModels";
import type { CollaborationObserverSignal } from "../shared/collaboration";
import { createMockApi } from "./helpers/collaborationReadModelFixtures";

const activeProject = { profileId: "profile-demo-001", projectId: "project-demo-001" };
const workItem = exampleAssignmentProjection.workItem;
const key = workItemKey(workItem);
const otherWorkItem: WorkItemRef = {
  kind: "task",
  canvasId: workItem.canvasId,
  taskId: "other-task"
};
const controllers: CollaborationReadModelController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function activeController(mock = createMockApi()) {
  const controller = new CollaborationReadModelController({ api: mock.api });
  controllers.push(controller);
  await controller.setActiveProject(activeProject);
  return { controller, mock };
}

function eventSignal(
  cursor: number,
  item: WorkItemRef,
  kind: "comment" | "attachment" = "comment"
): CollaborationObserverSignal {
  return {
    type: "human.observer.event",
    ...activeProject,
    event: { ...exampleObserverEvent, kind, cursor, previousCursor: cursor - 1, workItem: item }
  };
}

function catchupSignal(): CollaborationObserverSignal {
  return {
    type: "human.observer.catchup_required",
    ...activeProject,
    ...exampleObserverCatchupRequired
  };
}

describe("comment read model invalidation", () => {
  it.each([
    "comment",
    "attachment"
  ] as const)("publishes %s invalidation only after application and dedupes its cursor", async (kind) => {
    const { controller, mock } = await activeController();
    await controller.trackWorkItemComments(workItem);
    const initial = controller.getSnapshot();
    expect(initial.commentInvalidationVersionByWorkItem[key]).toBe(0);
    const page = deferred<typeof exampleCommentListPage>();
    mock.listComments.mockImplementationOnce(() => page.promise);
    const signal = eventSignal(21, workItem, kind);
    mock.signalListeners[0]!(signal);
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(0);
    page.resolve({
      items: [{ ...exampleCommentProjection, revision: 2, body: "observer edit" }],
      nextCursor: null
    });
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(21));
    const applied = controller.getSnapshot();
    const version = applied.commentInvalidationVersionByWorkItem[key]!;
    expect(version).toBeGreaterThan(0);
    expect(applied.commentsByWorkItem[key]?.[0]?.body).toBe("observer edit");
    expect(initial.commentInvalidationVersionByWorkItem[key]).toBe(0);
    const reads = mock.listComments.mock.calls.length;
    mock.signalListeners[0]!(signal);
    await Promise.resolve();
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(version);
    expect(mock.listComments).toHaveBeenCalledTimes(reads);

    await controller.trackWorkItemComments(workItem);
    await controller.refreshAuthoritative();
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(version);
  });

  it("isolates unrelated work items, profiles and non-comment events", async () => {
    const { controller, mock } = await activeController();
    await controller.trackWorkItemComments(workItem);
    const listener = mock.signalListeners[0]!;
    listener({ ...eventSignal(10, workItem), profileId: "profile-other" });
    listener(eventSignal(11, otherWorkItem));
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(11));
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(0);
    expect(
      controller.getSnapshot().commentInvalidationVersionByWorkItem[workItemKey(otherWorkItem)]
    ).toBeGreaterThan(0);
    listener({
      ...eventSignal(12, workItem),
      event: { ...exampleObserverEvent, kind: "invitation", cursor: 12, previousCursor: 11 }
    });
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(12));
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(0);
  });

  it("keeps failed observer projections and retries the same cursor before publishing invalidation", async () => {
    const { controller, mock } = await activeController();
    await controller.trackWorkItemComments(workItem);
    mock.listComments.mockRejectedValueOnce({
      kind: "network",
      code: "observer_comments_failed",
      message: "Comments reload failed.",
      retryable: true
    });
    const listener = mock.signalListeners[0]!;
    const signal = eventSignal(21, workItem);
    listener(signal);
    await waitFor(() =>
      expect(controller.getSnapshot().lastError?.code).toBe("observer_comments_failed")
    );
    expect(controller.getSnapshot().commentsByWorkItem[key]).toEqual(exampleCommentListPage.items);
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(0);
    expect(controller.getSnapshot().observerCursor).toBe(0);
    mock.listComments.mockResolvedValueOnce({
      items: [{ ...exampleCommentProjection, revision: 2, body: "retried edit" }],
      nextCursor: null
    });
    listener(signal);
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(21));
    expect(controller.getSnapshot().commentsByWorkItem[key]?.[0]?.body).toBe("retried edit");
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBeGreaterThan(0);
  });

  it("advances only confirmed mutations and keeps failures observable", async () => {
    const completion = deferred<typeof exampleCommentProjection>();
    const mock = createMockApi({ onEditComment: vi.fn(() => completion.promise) });
    const { controller } = await activeController(mock);
    await controller.trackWorkItemComments(workItem);
    const mutation = controller.editComment({
      commentId: exampleCommentProjection.commentId,
      expectedRevision: 1,
      body: "confirmed edit"
    });
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(0);
    completion.resolve({ ...exampleCommentProjection, revision: 2, body: "confirmed edit" });
    await mutation;
    const version = controller.getSnapshot().commentInvalidationVersionByWorkItem[key]!;
    expect(version).toBeGreaterThan(0);
    expect(controller.getSnapshot().commentsByWorkItem[key]?.[0]?.body).toBe("confirmed edit");
    mock.api.editCollaborationComment = vi.fn().mockRejectedValue({
      kind: "network",
      code: "edit_failed",
      message: "Edit failed.",
      retryable: true
    });
    expect(
      await controller.editComment({
        commentId: exampleCommentProjection.commentId,
        expectedRevision: 2,
        body: "rejected edit"
      })
    ).toBeNull();
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(version);
    expect(controller.getSnapshot().commentsByWorkItem[key]?.[0]?.body).toBe("confirmed edit");
    expect(controller.getSnapshot().lastError?.code).toBe("edit_failed");
    await controller.tombstoneComment({
      commentId: exampleCommentProjection.commentId,
      expectedRevision: 2
    });
    const tombstoneVersion = controller.getSnapshot().commentInvalidationVersionByWorkItem[key]!;
    expect(tombstoneVersion).toBeGreaterThan(version);
    await controller.createComment({ workItem, body: "new comment" });
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBeGreaterThan(
      tombstoneVersion
    );
  });

  it("rebuilds catchup versions while retaining the last same-scope projection on failure", async () => {
    const { controller, mock } = await activeController();
    await controller.trackWorkItemComments(workItem);
    await controller.createComment({ workItem, body: "new comment" });
    const previous = controller.getSnapshot();
    const completion = deferred<typeof exampleCommentListPage>();
    mock.listComments.mockImplementationOnce(() => completion.promise);
    mock.signalListeners[0]!(catchupSignal());
    expect(controller.getSnapshot().commentsByWorkItem[key]).toEqual(
      previous.commentsByWorkItem[key]
    );
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(
      previous.commentInvalidationVersionByWorkItem[key]! + 1
    );
    completion.reject({
      kind: "network",
      code: "catchup_comments_failed",
      message: "Comments reload failed.",
      retryable: true
    });
    await waitFor(() =>
      expect(controller.getSnapshot().lastError?.code).toBe("catchup_comments_failed")
    );
    expect(controller.getSnapshot().commentsByWorkItem[key]).toEqual(
      previous.commentsByWorkItem[key]
    );
    const version = controller.getSnapshot().commentInvalidationVersionByWorkItem[key];
    await controller.trackWorkItemComments(workItem);
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(version);
  });

  it("invalidates tracked comments when an observer queue gap requires authoritative recovery", async () => {
    const { controller, mock } = await activeController();
    await controller.trackWorkItemComments(workItem);
    const listener = mock.signalListeners[0]!;
    for (let cursor = 1; cursor <= 140; cursor += 1) {
      listener({
        ...eventSignal(cursor, workItem),
        event: { ...exampleObserverEvent, kind: "invitation", cursor, previousCursor: cursor - 1 }
      });
    }
    await waitFor(() =>
      expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBeGreaterThan(0)
    );
    await waitFor(() => expect(controller.getSnapshot().syncPhase).toBe("ready"));
    expect(controller.getSnapshot().commentsByWorkItem[key]).toEqual(exampleCommentListPage.items);
    expect(mock.listComments.mock.calls.length).toBeGreaterThan(1);
  });

  it("rejects retired callbacks and late comment reloads after an A-B-A project switch", async () => {
    const { controller, mock } = await activeController();
    await controller.trackWorkItemComments(workItem);
    const retiredListener = mock.signalListeners[0]!;
    const completion = deferred<typeof exampleCommentListPage>();
    mock.listComments.mockImplementationOnce(() => completion.promise);
    retiredListener(eventSignal(21, workItem));
    await controller.setActiveProject({ profileId: "profile-other", projectId: "project-other" });
    await controller.setActiveProject(activeProject);
    await controller.trackWorkItemComments(workItem);
    completion.resolve({
      items: [{ ...exampleCommentProjection, revision: 99, body: "retired scope" }],
      nextCursor: null
    });
    await Promise.resolve();
    await Promise.resolve();
    const readsBeforeRetiredCallback = mock.listComments.mock.calls.length;
    retiredListener(eventSignal(22, workItem));
    expect(mock.listComments).toHaveBeenCalledTimes(readsBeforeRetiredCallback);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().observerCursor).toBe(0);
    expect(controller.getSnapshot().commentsByWorkItem[key]).toEqual(exampleCommentListPage.items);
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(0);
  });

  it("clears comment versions and projections on a real canvas scope change", async () => {
    const { controller } = await activeController();
    await controller.trackWorkItemComments(workItem);
    await controller.createComment({ workItem, body: "new comment" });
    await controller.setActiveProject({ ...activeProject, canvasId: "different-canvas" });
    expect(controller.getSnapshot().commentsByWorkItem).toEqual({});
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem).toEqual({});
    await controller.trackWorkItemComments(workItem);
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem[key]).toBe(0);
    controller.clear();
    expect(controller.getSnapshot().commentsByWorkItem).toEqual({});
    expect(controller.getSnapshot().commentInvalidationVersionByWorkItem).toEqual({});
  });
});
