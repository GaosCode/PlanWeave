/* @vitest-environment jsdom */

import { webcrypto } from "node:crypto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleObserverCatchupRequired } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { COMMENT_LIST_PAGE_DEFAULT } from "@planweave-ai/collaboration-protocol/core/limits";
import type {
  CommentDisplayProjection,
  CommentListPage
} from "@planweave-ai/collaboration-protocol/activity/comments";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  commentIsAfterCursor,
  compareCommentOrder,
  nextCommentCursor
} from "../../../server/src/comments/cursor";
import { acquireCollaborationReadModelController } from "../renderer/collaboration/collaborationReadModelHub";
import { resetCommentDraftStoreForTests } from "../renderer/collaboration/commentDraftStore";
import { useCommentsPanelController } from "../renderer/hooks/useCommentsPanelController";
import { createTranslator } from "../renderer/i18n";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import { taskItem, commentProjection, createApi } from "./helpers/commentsPanelFixture";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const releases: Array<() => void> = [];
const pageSize = COMMENT_LIST_PAGE_DEFAULT;
type Query = Parameters<PlanWeaveCollaborationApi["listCollaborationComments"]>[0];
const t = createTranslator("en");

afterEach(() => {
  cleanupRendererTestEnvironment();
  for (const release of releases.splice(0)) release();
  resetCommentDraftStoreForTests();
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

function records(count: number, item: WorkItemRef = taskItem): CommentDisplayProjection[] {
  return Array.from({ length: count }, (_, index) => ({
    ...commentProjection(`comment-${String(index + 1).padStart(4, "0")}`, `body-${index + 1}`),
    workItem: item,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z"
  }));
}

async function panel(count: number) {
  const fixture = createApi();
  let currentRecords = records(count);
  const readPage = (query: Query): CommentListPage => {
    const limit = query.limit ?? pageSize;
    const available = currentRecords
      .filter((record) => JSON.stringify(record.workItem) === JSON.stringify(query.workItem))
      .filter((record) => query.includeTombstoned || !record.tombstoned)
      .sort(compareCommentOrder)
      .filter((record) => !query.cursor || commentIsAfterCursor(record, query.cursor));
    const items = available.slice(0, limit);
    return { items, nextCursor: available.length > limit ? nextCommentCursor(items, limit) : null };
  };
  fixture.listComments.mockImplementation(async (query: Query) => readPage(query));
  const shell = acquireCollaborationReadModelController(fixture.api);
  releases.push(shell.release);
  await shell.controller.setActiveProject({
    profileId: "profile-1",
    projectId: "project-1",
    canvasId: "canvas-1"
  });
  const hook = renderHook(
    ({ item, open }: { item: WorkItemRef; open: boolean }) =>
      useCommentsPanelController({ workItem: item, open, api: fixture.api, t }),
    { initialProps: { item: taskItem, open: true } }
  );
  await waitFor(() => expect(hook.result.current.rows).toHaveLength(Math.min(count, pageSize)));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  let cursor = 0;
  const invalidate = (item: WorkItemRef = taskItem) => {
    cursor += 1;
    fixture.emitObserver({
      type: "human.observer.event",
      profileId: "profile-1",
      projectId: "project-1",
      event: {
        type: "human.observer.event",
        protocolVersion: 1,
        kind: "comment",
        workItem: item,
        cursor,
        previousCursor: cursor - 1,
        occurredAt: "2030-01-01T00:00:01.000Z"
      }
    });
  };
  const reads = () =>
    fixture.listComments.mock.calls
      .map(([query]) => query as Query)
      .filter((query) => query.limit === pageSize);
  return {
    ...fixture,
    ...hook,
    shell,
    readPage,
    reads,
    invalidate,
    setRecords: (next: CommentDisplayProjection[]) => {
      currentRecords = next;
    }
  };
}

async function loadPages(f: Awaited<ReturnType<typeof panel>>, depth: number) {
  for (let page = 1; page < depth; page += 1) await act(async () => f.result.current.loadMore());
}

describe("comments panel paginated revalidation", () => {
  it("refreshes later-page edits and tombstones without dropping raw history, drafts or attachments", async () => {
    const f = await panel(pageSize * 3 + 5);
    await loadPages(f, 4);
    vi.stubGlobal("crypto", webcrypto);
    vi.mocked(f.api.createCollaborationPendingAttachment).mockResolvedValue({
      pendingUploadId: "pending-image"
    });
    vi.mocked(f.api.uploadCollaborationPendingAttachment).mockResolvedValue(undefined);
    vi.mocked(f.api.finalizeCollaborationPendingAttachment).mockImplementation(async (command) => ({
      pendingUploadId: command.pendingUploadId,
      digestSha256: command.expectedDigestSha256,
      sizeBytes: 4,
      mediaType: "image/png"
    }));
    await act(async () => {
      f.result.current.setDraftBody("unsent body");
      await f.result.current.stageFiles([
        {
          name: "draft.png",
          type: "image/png",
          size: 4,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
        }
      ]);
    });
    await waitFor(() => expect(f.result.current.stagedAttachments[0]?.phase).toBe("ready"));
    const attachments = f.result.current.stagedAttachments;
    const editScope = f.result.current.editScope;
    const next = records(pageSize * 3 + 5);
    next[pageSize * 2 + 12] = {
      ...next[pageSize * 2 + 12]!,
      body: "second page edited",
      revision: 2
    };
    for (const index of [0, pageSize + 4, next.length - 1])
      next[index] = {
        ...next[index]!,
        body: null,
        tombstoned: true,
        revision: 2,
        tombstonedAt: "2030-01-01T00:00:02.000Z"
      };
    f.setRecords(next);
    f.listComments.mockClear();
    act(() => f.invalidate());
    await waitFor(() =>
      expect(
        f.result.current.rows.find((row) => row.commentId === next[pageSize * 2 + 12]!.commentId)
          ?.body
      ).toBe("second page edited")
    );
    expect(f.result.current.rows).toHaveLength(next.length - 3);
    expect(f.result.current.rows.map((row) => row.commentId)).toEqual(
      next.filter((record) => !record.tombstoned).map((record) => record.commentId)
    );
    expect(f.result.current.draft.body).toBe("unsent body");
    expect(f.result.current.stagedAttachments).toEqual(attachments);
    expect(f.result.current.editScope).toBe(editScope);
    expect(f.reads()).toHaveLength(4);
    expect(f.reads().every((query) => query.includeTombstoned)).toBe(true);
    next[pageSize * 2 + 12] = { ...next[pageSize * 2 + 12]!, body: "catchup revised", revision: 3 };
    f.listComments.mockClear();
    act(() =>
      f.emitObserver({
        ...exampleObserverCatchupRequired,
        type: "human.observer.catchup_required",
        profileId: "profile-1",
        projectId: "project-1"
      })
    );
    await waitFor(() =>
      expect(
        f.result.current.rows.find((row) => row.commentId === next[pageSize * 2 + 12]!.commentId)
          ?.body
      ).toBe("catchup revised")
    );
    expect(f.reads()).toHaveLength(4);
    expect(f.result.current.draft.body).toBe("unsent body");
    expect(f.result.current.stagedAttachments).toEqual(attachments);
    expect(f.result.current.editScope).toBe(editScope);
  });

  it("discovers one bounded tail page after exhaustion and restores loadMore for a large append", async () => {
    const f = await panel(pageSize * 2 + 5);
    await loadPages(f, 3);
    expect(f.result.current.hasMore).toBe(false);
    f.setRecords(records(pageSize * 6));
    f.listComments.mockClear();
    act(() => f.invalidate());
    await waitFor(() => expect(f.result.current.rows).toHaveLength(pageSize * 4));
    expect(f.result.current.hasMore).toBe(true);
    expect(f.reads()).toHaveLength(4);
    expect(new Set(f.result.current.rows.map((row) => row.commentId)).size).toBe(pageSize * 4);
    await act(async () => f.result.current.loadMore());
    expect(f.result.current.rows).toHaveLength(pageSize * 5);
    expect(f.reads()).toHaveLength(5);
  });

  it("keeps an empty active first page loadable because tombstones occupy raw cursor depth", async () => {
    const f = await panel(pageSize + 2);
    const next = records(pageSize + 2);
    for (let index = 0; index < pageSize; index += 1)
      next[index] = {
        ...next[index]!,
        body: null,
        revision: 2,
        tombstoned: true,
        tombstonedAt: "2030-01-01T00:00:02.000Z"
      };
    f.setRecords(next);
    f.listComments.mockClear();
    act(() => f.invalidate());
    await waitFor(() => expect(f.result.current.rows).toHaveLength(0));
    expect(f.result.current.hasMore).toBe(true);
    expect(f.reads()).toHaveLength(1);
    await act(async () => f.result.current.loadMore());
    expect(f.result.current.rows.map((row) => row.commentId)).toEqual(
      next.slice(pageSize).map((record) => record.commentId)
    );
    expect(f.result.current.hasMore).toBe(false);
  });

  it("serializes a pending loadMore before coalesced invalidations without losing its target depth", async () => {
    const f = await panel(pageSize * 3 + 2);
    const pending = deferred<CommentListPage>();
    const stalePage = f.readPage({
      workItem: taskItem,
      limit: pageSize,
      includeTombstoned: true,
      cursor: {
        createdAt: "2030-01-01T00:00:00.000Z",
        commentId: `comment-${String(pageSize).padStart(4, "0")}`
      }
    });
    f.listComments.mockImplementation(async (query: Query) =>
      query.limit === pageSize && query.cursor ? pending.promise : f.readPage(query)
    );
    let load!: Promise<void>;
    act(() => {
      load = f.result.current.loadMore();
    });
    await waitFor(() => expect(f.result.current.loadingMore).toBe(true));
    const next = records(pageSize * 3 + 2);
    next[pageSize + 2] = { ...next[pageSize + 2]!, body: "latest body", revision: 3 };
    f.setRecords(next);
    f.listComments.mockClear();
    act(() => {
      f.invalidate();
      f.invalidate();
      f.invalidate();
    });
    await waitFor(() => expect(f.shell.controller.getSnapshot().observerCursor).toBe(3));
    expect(f.reads()).toHaveLength(0);
    f.listComments.mockImplementation(async (query: Query) => f.readPage(query));
    await act(async () => {
      pending.resolve(stalePage);
      await load;
    });
    await waitFor(() =>
      expect(
        f.result.current.rows.find((row) => row.commentId === next[pageSize + 2]!.commentId)?.body
      ).toBe("latest body")
    );
    expect(f.result.current.rows).toHaveLength(pageSize * 2);
    expect(f.reads()).toHaveLength(2);
  });

  it("preserves append intent arriving during revalidation and does not publish a partial failed refresh", async () => {
    const f = await panel(pageSize * 3 + 2);
    await loadPages(f, 2);
    const pending = deferred<CommentListPage>();
    f.listComments.mockImplementation(async (query: Query) =>
      query.limit === pageSize && !query.cursor ? pending.promise : f.readPage(query)
    );
    f.listComments.mockClear();
    act(() => f.invalidate());
    await waitFor(() => expect(f.reads()).toHaveLength(1));
    let load!: Promise<void>;
    act(() => {
      load = f.result.current.loadMore();
    });
    const next = records(pageSize * 3 + 2);
    next[2] = { ...next[2]!, body: "updated first page", revision: 2 };
    f.setRecords(next);
    f.listComments.mockImplementation(async (query: Query) => f.readPage(query));
    await act(async () => {
      pending.resolve(f.readPage({ workItem: taskItem, limit: pageSize, includeTombstoned: true }));
      await load;
    });
    expect(f.result.current.rows).toHaveLength(pageSize * 3);
    expect(f.result.current.rows[2]?.body).toBe("updated first page");
    const before = f.result.current.rows;
    f.listComments.mockImplementation(async (query: Query) => {
      if (query.limit === pageSize && query.cursor)
        throw { kind: "network", code: "page_failed", message: "page_failed", retryable: true };
      return f.readPage(query);
    });
    act(() => f.invalidate());
    await waitFor(() => expect(f.result.current.actionError).toContain("page_failed"));
    expect(f.result.current.rows).toEqual(before);
    expect(f.result.current.hasMore).toBe(true);
    f.listComments.mockImplementation(async (query: Query) => f.readPage(query));
    await act(async () => f.result.current.refresh());
    expect(f.result.current.rows).toHaveLength(pageSize);
    expect(f.result.current.hasMore).toBe(true);
  });

  it("drains newer invalidations arriving mid-read and never rolls back a confirmed revision", async () => {
    const f = await panel(pageSize * 3 + 2);
    await loadPages(f, 2);
    const pending = deferred<CommentListPage>();
    const stale = f.readPage({ workItem: taskItem, limit: pageSize, includeTombstoned: true });
    f.listComments.mockImplementation(async (query: Query) =>
      query.limit === pageSize && !query.cursor ? pending.promise : f.readPage(query)
    );
    f.listComments.mockClear();
    act(() => f.invalidate());
    await waitFor(() => expect(f.reads()).toHaveLength(1));
    const next = records(pageSize * 3 + 2);
    next[1] = { ...next[1]!, body: "latest during read", revision: 3 };
    f.setRecords(next);
    act(() => {
      f.invalidate();
      f.invalidate();
    });
    await waitFor(() => expect(f.shell.controller.getSnapshot().observerCursor).toBe(3));
    expect(f.reads()).toHaveLength(1);
    f.listComments.mockImplementation(async (query: Query) => f.readPage(query));
    await act(async () => pending.resolve(stale));
    await waitFor(() => expect(f.result.current.loading).toBe(false));
    expect(f.reads()).toHaveLength(4);
    expect(f.result.current.rows[1]).toMatchObject({ body: "latest during read", revision: 3 });
    f.editComment.mockResolvedValue({ ...next[1]!, body: "confirmed revision", revision: 4 });
    await act(async () => {
      expect(await f.result.current.editComment(next[1]!.commentId, "confirmed revision", 3)).toBe(
        true
      );
    });
    await waitFor(() => expect(f.result.current.loading).toBe(false));
    expect(f.result.current.rows[1]).toMatchObject({ body: "confirmed revision", revision: 4 });
    f.listComments.mockClear();
    act(() => f.invalidate({ kind: "task", canvasId: "canvas-1", taskId: "unrelated" }));
    await waitFor(() => expect(f.shell.controller.getSnapshot().observerCursor).toBe(4));
    expect(f.reads()).toHaveLength(0);
    expect(f.result.current.rows[1]).toMatchObject({ body: "confirmed revision", revision: 4 });
  });

  it.each([
    "profile",
    "unmount"
  ])("rejects a delayed raw page after %s retirement", async (transition) => {
    const f = await panel(pageSize + 2);
    const pending = deferred<CommentListPage>();
    f.listComments.mockImplementationOnce(() => pending.promise);
    let loading!: Promise<void>;
    act(() => {
      loading = f.result.current.loadMore();
    });
    await waitFor(() => expect(f.result.current.loadingMore).toBe(true));
    if (transition === "unmount") f.unmount();
    else {
      f.setRecords(records(2));
      await act(async () => {
        f.changeStatus("project-1", "profile-2");
        await f.shell.controller.setActiveProject({
          profileId: "profile-2",
          projectId: "project-1",
          canvasId: "canvas-1"
        });
      });
      await waitFor(() => expect(f.result.current.rows).toHaveLength(2));
      await act(async () => f.result.current.setDraftBody("profile two draft"));
    }
    await act(async () => {
      pending.resolve({
        items: [{ ...records(1)[0]!, body: "retired raw page", revision: 99 }],
        nextCursor: null
      });
      await loading;
    });
    expect(f.result.current.rows.some((row) => row.body === "retired raw page")).toBe(false);
    if (transition === "profile") {
      expect(f.result.current.rows).toHaveLength(2);
      expect(f.result.current.draft.body).toBe("profile two draft");
    }
  });

  it("fences a delayed list across work-item A-B-A and close without erasing new composer state", async () => {
    const f = await panel(pageSize + 2);
    const old = deferred<CommentListPage>();
    f.listComments.mockImplementationOnce(() => old.promise);
    let loading!: Promise<void>;
    act(() => {
      loading = f.result.current.loadMore();
    });
    const b: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-B" };
    await waitFor(() => expect(f.result.current.loadingMore).toBe(true));
    f.setRecords([...records(pageSize + 2), ...records(2, b)]);
    f.rerender({ item: b, open: true });
    await waitFor(() => expect(f.result.current.rows).toHaveLength(2));
    f.rerender({ item: taskItem, open: true });
    await waitFor(() => expect(f.result.current.rows).toHaveLength(pageSize));
    await act(async () => f.result.current.setDraftBody("current A draft"));
    await act(async () => {
      old.resolve({
        items: [{ ...records(1)[0]!, body: "retired page", revision: 99 }],
        nextCursor: null
      });
      await loading;
    });
    expect(f.result.current.rows).toHaveLength(pageSize);
    expect(f.result.current.rows.some((row) => row.body === "retired page")).toBe(false);
    expect(f.result.current.draft.body).toBe("current A draft");
    f.rerender({ item: taskItem, open: false });
    expect(f.result.current.rows).toEqual([]);
    f.rerender({ item: taskItem, open: true });
    await waitFor(() => expect(f.result.current.rows).toHaveLength(pageSize));
  });
});
