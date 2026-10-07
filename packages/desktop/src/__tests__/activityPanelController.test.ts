/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityRecord,
  ActivityListPage
} from "@planweave-ai/collaboration-protocol/activity/comments";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { acquireCollaborationReadModelController } from "../renderer/collaboration/collaborationReadModelHub";
import { useActivityPanelController } from "../renderer/hooks/useActivityPanelController";
import { createTranslator } from "../renderer/i18n";
import { connectedStatus, createApi, taskItem } from "./helpers/commentsPanelFixture";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const releases: Array<() => void> = [];
afterEach(() => {
  cleanupRendererTestEnvironment();
  for (const release of releases.splice(0)) release();
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

function record(
  id: string,
  time = "02",
  workItem = taskItem,
  projectId = "project-1"
): ActivityRecord {
  return {
    activityId: id,
    projectId,
    type: "comment_created",
    source: { kind: "comment", sourceId: id },
    summary: { headline: id, commentId: id, workItem },
    subjects: [],
    workItem,
    occurredAt: `2030-01-01T00:00:${time}.000Z`
  };
}
const old = record("old", "01");
const cursor = { occurredAt: old.occurredAt, activityId: old.activityId };
const first: ActivityListPage = { items: [old], nextCursor: cursor };

async function panel(initial?: ReturnType<typeof deferred<ActivityListPage>>) {
  const f = createApi();
  let hubItems = [old];
  f.listActivity.mockImplementation(async (query: { workItem?: WorkItemRef; cursor?: unknown }) => {
    if (!query.workItem) return { items: hubItems, nextCursor: null };
    if (initial) return initial.promise;
    return query.cursor ? { items: [], nextCursor: null } : first;
  });
  const shell = acquireCollaborationReadModelController(f.api);
  releases.push(shell.release);
  await shell.controller.setActiveProject({
    profileId: "profile-1",
    projectId: "project-1",
    canvasId: "canvas-1"
  });
  const hook = renderHook(
    ({ item, open }: { item: WorkItemRef; open: boolean }) =>
      useActivityPanelController({ workItem: item, open, api: f.api, t: createTranslator("en") }),
    { initialProps: { item: taskItem, open: true } }
  );
  await waitFor(() => expect(f.listActivity.mock.calls.some(([q]) => q.workItem)).toBe(true));
  if (!initial) await waitFor(() => expect(hook.result.current.loading).toBe(false));
  let eventCursor = 0;
  return {
    ...f,
    ...hook,
    shell,
    emit: (items: ActivityRecord[], projectId = "project-1", profileId = "profile-1") => {
      hubItems = items;
      eventCursor += 1;
      f.emitObserver({
        type: "human.observer.event",
        profileId,
        projectId,
        event: {
          type: "human.observer.event",
          protocolVersion: 1,
          kind: "activity",
          cursor: eventCursor,
          previousCursor: eventCursor - 1,
          occurredAt: "2030-01-01T00:00:03.000Z"
        }
      });
    },
    scopedReads: () => f.listActivity.mock.calls.filter(([q]) => q.workItem),
    ids: () => hook.result.current.rows.map((row) => row.activityId)
  };
}

describe("Activity request ownership", () => {
  it.each([
    "initial",
    "refresh"
  ])("retains only arrivals during %s replace and preserves server cursor", async (phase) => {
    const pending = deferred<ActivityListPage>();
    const f = await panel(phase === "initial" ? pending : undefined);
    let request: Promise<void> | undefined;
    if (phase === "refresh") {
      f.listActivity.mockImplementationOnce(() => pending.promise);
      act(() => {
        request = f.result.current.refresh();
      });
    }
    await waitFor(() => expect(f.result.current.loading).toBe(true));
    const a = record("live-a"),
      z = record("live-z");
    act(() =>
      f.emit([old, a, z, a, record("unrelated", "03", { ...taskItem, taskId: "T-other" })])
    );
    await waitFor(() => expect(f.ids()).toContain("live-z"));
    await act(async () => {
      pending.resolve(first);
      await request;
    });
    await waitFor(() => expect(f.result.current.loading).toBe(false));
    expect(f.ids()).toEqual(["live-z", "live-a", "old"]);
    f.listActivity.mockResolvedValueOnce({ items: [], nextCursor: null });
    await act(async () => f.result.current.loadMore());
    expect(f.scopedReads().at(-1)?.[0].cursor).toEqual(cursor);
    expect(f.result.current.hasMore).toBe(false);
    expect(f.ids()).toEqual(["live-z", "live-a", "old"]);
    f.listActivity.mockResolvedValueOnce({ items: [], nextCursor: null });
    await act(async () => f.result.current.refresh());
    expect(f.ids()).toEqual([]);
  });

  it("preserves project-wide Hub arrivals when the observer releases HTTP in the same batch", async () => {
    const fixture = createApi();
    const shell = acquireCollaborationReadModelController(fixture.api);
    releases.push(shell.release);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });
    const pending = deferred<ActivityListPage>();
    const live = record("live-project", "03", { ...taskItem, taskId: "other" });
    fixture.listActivity
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ items: [live, old], nextCursor: null });
    const hook = renderHook(() =>
      useActivityPanelController({ open: true, api: fixture.api, t: createTranslator("en") })
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(true));
    const unsubscribe = shell.controller.subscribe((snapshot) => {
      if (snapshot.activity.some((item) => item.activityId === live.activityId))
        pending.resolve(first);
    });
    releases.push(unsubscribe);
    act(() =>
      fixture.emitObserver({
        type: "human.observer.event",
        profileId: "profile-1",
        projectId: "project-1",
        event: {
          type: "human.observer.event",
          protocolVersion: 1,
          kind: "activity",
          cursor: 1,
          previousCursor: 0,
          occurredAt: live.occurredAt
        }
      })
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.rows.map((row) => row.activityId)).toEqual(["live-project", "old"]);
    expect(hook.result.current.hasMore).toBe(true);
  });

  it("retires failed requests during disconnect and reloads after reconnect", async () => {
    const f = await panel();
    const pending = deferred<ActivityListPage>();
    f.listActivity.mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    act(() => {
      request = f.result.current.refresh();
    });
    const disconnected = connectedStatus();
    disconnected.session.phase = "reconnecting";
    act(() => {
      for (const [listener] of vi.mocked(f.api.onCollaborationStatusChanged).mock.calls)
        listener(disconnected);
    });
    expect(f.result.current.loading).toBe(false);
    expect(f.ids()).toEqual([]);
    await act(async () => {
      pending.reject(new Error("retired network error"));
      await request;
    });
    expect(f.result.current.actionError).toBeNull();
    f.listActivity.mockResolvedValue({ items: [record("reconnected")], nextCursor: null });
    act(() => f.changeStatus("project-1"));
    await waitFor(() => expect(f.ids()).toEqual(["reconnected"]));
    expect(f.result.current.loading).toBe(false);
    expect(f.result.current.loadingMore).toBe(false);
    expect(f.result.current.actionError).toBeNull();
  });

  it.each([
    "hub-first",
    "page-first"
  ])("deduplicates append with Hub in %s order and serializes repeated loadMore", async (order) => {
    const f = await panel();
    const pending = deferred<ActivityListPage>();
    f.listActivity.mockImplementationOnce(() => pending.promise);
    const reads = f.scopedReads().length;
    let request!: Promise<void>;
    act(() => {
      request = f.result.current.loadMore();
      void f.result.current.loadMore();
    });
    await waitFor(() => expect(f.result.current.loadingMore).toBe(true));
    const live = record("live");
    if (order === "hub-first") {
      act(() => f.emit([live, old]));
      await waitFor(() => expect(f.ids()).toContain("live"));
    }
    await act(async () => {
      pending.resolve({ items: [record("tail", "00"), live, live], nextCursor: null });
      await request;
    });
    if (order === "page-first") {
      act(() => f.emit([live, old]));
      await waitFor(() => expect(f.shell.controller.getSnapshot().observerCursor).toBe(1));
    }
    expect(f.scopedReads()).toHaveLength(reads + 1);
    expect(f.ids()).toEqual(["live", "old", "tail"]);
    expect(f.result.current.loadingMore).toBe(false);
    expect(f.result.current.hasMore).toBe(false);
  });

  it("lets refresh own cursor, busy and errors when it supersedes append and another refresh", async () => {
    const f = await panel();
    const append = deferred<ActivityListPage>(),
      replaced = deferred<ActivityListPage>(),
      current = deferred<ActivityListPage>();
    f.listActivity
      .mockImplementationOnce(() => append.promise)
      .mockImplementationOnce(() => replaced.promise)
      .mockImplementationOnce(() => current.promise);
    let a!: Promise<void>, b!: Promise<void>, c!: Promise<void>;
    act(() => {
      a = f.result.current.loadMore();
      b = f.result.current.refresh();
      c = f.result.current.refresh();
      void f.result.current.loadMore();
    });
    await act(async () => {
      append.reject(new Error("retired append"));
      replaced.resolve(first);
      await a;
      await b;
    });
    expect(f.result.current.loading).toBe(true);
    expect(f.result.current.loadingMore).toBe(false);
    expect(f.result.current.actionError).toBeNull();
    await act(async () => {
      current.resolve({ items: [record("current")], nextCursor: cursor });
      await c;
    });
    expect(f.ids()).toEqual(["current"]);
    expect(f.result.current.loading).toBe(false);
    expect(f.result.current.hasMore).toBe(true);
    f.listActivity.mockRejectedValueOnce(new Error("retry me"));
    await act(async () => f.result.current.loadMore());
    expect(f.result.current.actionError).toContain("retry me");
    expect(f.result.current.hasMore).toBe(true);
    f.listActivity.mockResolvedValueOnce({ items: [], nextCursor: null });
    await act(async () => f.result.current.loadMore());
    expect(f.result.current.actionError).toBeNull();
    expect(f.result.current.hasMore).toBe(false);
  });

  it.each([
    "work-item",
    "profile",
    "project",
    "close",
    "unmount"
  ])("fences delayed pages across %s retirement", async (transition) => {
    const f = await panel();
    const pending = deferred<ActivityListPage>();
    f.listActivity.mockImplementationOnce(() => pending.promise);
    let request!: Promise<void>;
    act(() => {
      request = f.result.current.loadMore();
    });
    await waitFor(() => expect(f.result.current.loadingMore).toBe(true));
    f.listActivity.mockResolvedValue({ items: [record("current")], nextCursor: null });
    if (transition === "work-item") {
      f.rerender({ item: { ...taskItem, taskId: "B" }, open: true });
      await waitFor(() => expect(f.ids()).toEqual(["current"]));
      f.rerender({ item: taskItem, open: true });
      await waitFor(() => expect(f.result.current.loading).toBe(false));
    } else if (transition === "profile" || transition === "project") {
      const profileId = transition === "profile" ? "profile-2" : "profile-1";
      const projectId = transition === "project" ? "project-2" : "project-1";
      f.listActivity.mockResolvedValue({
        items: [record("current", "02", taskItem, projectId)],
        nextCursor: null
      });
      await act(async () => {
        f.changeStatus(projectId, profileId);
        await f.shell.controller.setActiveProject({ profileId, projectId, canvasId: "canvas-1" });
      });
      await waitFor(() => expect(f.result.current.loading).toBe(false));
    } else if (transition === "close") f.rerender({ item: taskItem, open: false });
    else f.unmount();
    await act(async () => {
      pending.resolve({ items: [record("retired", "09")], nextCursor: cursor });
      await request;
    });
    expect(f.ids()).not.toContain("retired");
    if (transition !== "unmount") {
      expect(f.result.current.loadingMore).toBe(false);
      if (transition === "close") expect(f.ids()).toEqual([]);
      else expect(f.ids()).toEqual(["current"]);
    }
  });
});
