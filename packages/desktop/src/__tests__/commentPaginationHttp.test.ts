import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import {
  commentDisplayProjectionSchema,
  commentListPageSchema,
  type CommentListCursor,
  type CommentDisplayProjection
} from "@planweave-ai/collaboration-protocol/activity/comments";
import type { DistributedServerComposition } from "../../../server/src/serverComposition";
import { setupServerCompositionFixture } from "../../../server/src/__tests__/support/serverCompositionFixture";
import {
  CommentPaginationSession,
  emptyCommentPaginationSnapshot
} from "../renderer/collaboration/commentPaginationSession";

const directories: string[] = [];
const httpServers: Server[] = [];
const compositions: DistributedServerComposition[] = [];
afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

it("revalidates raw pages using real Server ASC keysets and bounds exhausted tail discovery", async () => {
  const fixture = await setupServerCompositionFixture({ directories, httpServers, compositions });
  const base = `${fixture.origin}/api/v1/projects/${fixture.projectId}`;
  const bootstrap = await fetch(`${base}/human/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Pagination owner", humanPrincipalId: "pagination-owner" })
  });
  expect(bootstrap.status).toBe(201);
  const { deviceToken } = z.object({ deviceToken: z.string() }).parse(await bootstrap.json());
  const headers = { Authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };
  const workItem = { kind: "task", canvasId: "default", taskId: "T-001" };
  const create = async (body: string): Promise<CommentDisplayProjection> => {
    const response = await fetch(`${base}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workItem, body })
    });
    expect(response.status).toBe(201);
    return commentDisplayProjectionSchema.parse(await response.json());
  };
  const created: CommentDisplayProjection[] = [];
  for (let index = 0; index < 7; index += 1) created.push(await create(`body ${index}`));
  let snapshot = emptyCommentPaginationSnapshot();
  const cursors: Array<CommentListCursor | undefined> = [];
  const session = new CommentPaginationSession({
    initialVersion: 0,
    listPage: async (cursor) => {
      cursors.push(cursor);
      const query = new URLSearchParams({
        workItem: JSON.stringify(workItem),
        limit: "2",
        includeTombstoned: "true"
      });
      if (cursor) query.set("cursor", JSON.stringify(cursor));
      const response = await fetch(`${base}/comments?${query}`, { headers });
      expect(response.status).toBe(200);
      return commentListPageSchema.parse(await response.json());
    },
    onChange: (next) => {
      snapshot = next;
    },
    onError: (error) => {
      throw error;
    },
    onRequestStart: () => {}
  });
  try {
    await session.start();
    for (let page = 1; page < 4; page += 1) await session.loadMore();
    const initialOrder = snapshot.items.map((item) => item.commentId);
    expect(new Set(initialOrder).size).toBe(7);
    expect(snapshot.nextCursor).toBeNull();
    const later = snapshot.items[5]!;
    const head = snapshot.items[0]!;
    const edited = await fetch(`${base}/comments/${later.commentId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body: "later revised", expectedRevision: 1 })
    });
    expect(edited.status).toBe(200);
    const deleted = await fetch(`${base}/comments/${head.commentId}/tombstone`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 1 })
    });
    expect(deleted.status).toBe(200);
    cursors.length = 0;
    await session.invalidate(1);
    expect(cursors).toHaveLength(4);
    expect(snapshot.items.map((item) => item.commentId)).toEqual(initialOrder);
    expect(snapshot.items[0]?.tombstoned).toBe(true);
    expect(snapshot.items[5]).toMatchObject({ body: "later revised", revision: 2 });
    for (let index = 7; index < 15; index += 1) await create(`body ${index}`);
    cursors.length = 0;
    await session.invalidate(2);
    expect(cursors).toHaveLength(5);
    expect(snapshot.items).toHaveLength(10);
    expect(new Set(snapshot.items.map((item) => item.commentId)).size).toBe(10);
    expect(snapshot.nextCursor).not.toBeNull();
    const serverCursor = snapshot.nextCursor;
    await session.loadMore();
    expect(cursors.at(-1)).toEqual(serverCursor);
    expect(snapshot.items).toHaveLength(12);
  } finally {
    session.dispose();
  }
});
