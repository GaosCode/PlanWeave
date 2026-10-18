/* @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  getCommentDraft,
  getCommentDraftScope,
  resetCommentDraftStoreForTests,
  setCommentDraft
} from "../renderer/collaboration/commentDraftStore";
import { useCollaborationStatus } from "../renderer/hooks/useCollaborationStatus";
import { createApi, connectedStatus, taskItem } from "./helpers/commentsPanelFixture";
import { deferred } from "./helpers/commentsComposerFixture";

afterEach(() => {
  cleanup();
  resetCommentDraftStoreForTests();
  vi.restoreAllMocks();
});

it.each([
  "pending",
  "failed"
] as const)("keeps a %s refresh observable when another status consumer mounts", async (phase) => {
  const { api, emitStatus } = createApi();
  const shell = renderHook(() => useCollaborationStatus({ api }));
  await waitFor(() => expect(shell.result.current.status?.session.phase).toBe("connected"));
  const pending = deferred<ReturnType<typeof connectedStatus>>();
  vi.mocked(api.getCollaborationStatus).mockReturnValueOnce(pending.promise);
  let refresh!: Promise<void>;
  act(() => {
    refresh = shell.result.current.refresh();
  });
  if (phase === "failed")
    await act(async () => {
      pending.reject(new Error("refresh unavailable"));
      await refresh;
    });
  const panel = renderHook(() => useCollaborationStatus({ api }));
  expect(panel.result.current.loading).toBe(phase === "pending");
  expect(shell.result.current.loading).toBe(phase === "pending");
  expect(panel.result.current.error).toBe(phase === "failed" ? "refresh unavailable" : null);
  expect(shell.result.current.error).toBe(phase === "failed" ? "refresh unavailable" : null);
  await act(async () => {
    if (phase === "pending") {
      pending.resolve(connectedStatus());
      await refresh;
    } else emitStatus(connectedStatus());
  });
  expect(shell.result.current.loading).toBe(false);
  expect(panel.result.current.error).toBeNull();
});

it("releases the shared event subscription only after its final consumer leaves", async () => {
  const f = createApi();
  let active = 0;
  const subscribe = vi.mocked(f.api.onCollaborationStatusChanged).getMockImplementation();
  if (!subscribe) throw new Error("fixture status subscription missing");
  vi.spyOn(f.api, "onCollaborationStatusChanged").mockImplementation((listener) => {
    ++active;
    const release = subscribe(listener);
    return () => {
      --active;
      release();
    };
  });
  const shell = renderHook(() => useCollaborationStatus({ api: f.api }));
  const panel = renderHook(() => useCollaborationStatus({ api: f.api }));
  await waitFor(() => expect(panel.result.current.status).not.toBeNull());
  expect(active).toBe(1);
  panel.unmount();
  expect(active).toBe(1);
  shell.unmount();
  expect(active).toBe(0);
});

it.each([
  "idle",
  "failure"
] as const)("retires a prior API A %s read after A→B→A and settles the new activation's read", async (outcome) => {
  const a = createApi();
  const b = createApi();
  const retained = renderHook(() => useCollaborationStatus({ api: a.api }));
  const shell = renderHook(({ api }) => useCollaborationStatus({ api }), {
    initialProps: { api: a.api }
  });
  await waitFor(() => expect(shell.result.current.status?.session.phase).toBe("connected"));
  const old = deferred<ReturnType<typeof connectedStatus>>();
  const fresh = deferred<ReturnType<typeof connectedStatus>>();
  const reads = vi.mocked(a.api.getCollaborationStatus).mock.calls.length;
  vi.mocked(a.api.getCollaborationStatus)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  let oldRefresh!: Promise<void>;
  act(() => {
    oldRefresh = retained.result.current.refresh();
  });
  shell.rerender({ api: b.api });
  await waitFor(() => expect(shell.result.current.status?.session.phase).toBe("connected"));
  shell.rerender({ api: a.api });
  const scope = getCommentDraftScope(a.api);
  act(() => setCommentDraft(taskItem, { body: "new A body" }, scope));
  expect(getCommentDraft(taskItem, scope).body).toBe("new A body");
  await act(async () => {
    if (outcome === "idle") {
      const stale = connectedStatus();
      stale.session.phase = "idle";
      old.resolve(stale);
    } else old.reject(new Error("prior activation unavailable"));
    await oldRefresh;
  });
  expect(getCommentDraft(taskItem, scope).body).toBe("new A body");
  expect(shell.result.current.status?.session.phase).toBe("connected");
  expect(shell.result.current.loading).toBe(true);
  expect(shell.result.current.error).toBeNull();
  expect(a.api.getCollaborationStatus).toHaveBeenCalledTimes(reads + 2);
  await act(async () => fresh.resolve(connectedStatus()));
  await waitFor(() => expect(shell.result.current.loading).toBe(false));
  expect(retained.result.current.loading).toBe(false);
  expect(getCommentDraft(taskItem, scope).body).toBe("new A body");
  // The new activation still accepts later authoritative invalidation.
  const disconnected = connectedStatus();
  disconnected.session.phase = "idle";
  act(() => a.emitStatus(disconnected));
  expect(shell.result.current.status?.session.phase).toBe("idle");
  expect(getCommentDraft(taskItem, scope).body).toBe("");
});
