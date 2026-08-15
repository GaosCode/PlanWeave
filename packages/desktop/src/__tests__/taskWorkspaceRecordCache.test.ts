/* @vitest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react";
import type { TaskWorkspaceRunDetail } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  TaskWorkspaceRecordCache,
  useTaskWorkspaceRecordCache
} from "../renderer/task-workspace/useTaskWorkspaceRecordCache";
import { deferred } from "./helpers/desktopProjectFixtures";
import { navigation, projectedRun, record } from "./helpers/taskWorkspaceControllerModelFixture";

const baseNavigation = navigation();

function identity(recordId: string, authorityKey = "authority-a", blockRef = "T-001#B-001") {
  return {
    authorityKey,
    blockRef,
    canvasId: baseNavigation.canvasId,
    projectRoot: baseNavigation.projectRoot,
    recordId,
    taskId: baseNavigation.taskId
  };
}

function detail(
  recordId: string,
  marker = recordId,
  blockRef = "T-001#B-001"
): TaskWorkspaceRunDetail {
  const runId = recordId.split("::")[1] ?? "RUN-001";
  const run = projectedRun(runId);
  const blockId = blockRef.split("#")[1] ?? "B-001";
  return {
    version: "planweave.task-workspace-run-detail/v1",
    projectRoot: baseNavigation.projectRoot,
    canvasId: baseNavigation.canvasId,
    taskId: baseNavigation.taskId,
    blockRef,
    item: {
      retryIndex: 1,
      active: false,
      selected: true,
      waitingInteraction: { active: false, count: 0, kinds: [] },
      run: {
        ...run,
        record: { ...run.record, blockId, recordId, ref: blockRef }
      }
    },
    record: { ...record(recordId, null), blockId, ref: blockRef, stdoutSummary: marker }
  };
}

describe("TaskWorkspaceRecordCache", () => {
  it("keeps the Block cache identity out of the Runtime run-detail request", async () => {
    const recordId = "T-001#B-001::RUN-001";
    const getTaskWorkspaceRunDetail = vi.fn(async () => detail(recordId));
    const api = { getTaskWorkspaceRunDetail };
    const onRecordReady = vi.fn();
    const selectionIdentity = {
      blockRef: "T-001#B-001",
      canvasId: baseNavigation.canvasId,
      projectRoot: baseNavigation.projectRoot,
      recordId,
      taskId: baseNavigation.taskId
    };

    const { result } = renderHook(() =>
      useTaskWorkspaceRecordCache({
        api,
        authorityKey: "authority-a",
        enabled: true,
        identity: selectionIdentity,
        onRecordReady,
        syntheticLoad: null
      })
    );

    await waitFor(() => expect(result.current.recordLoad.status).toBe("ready"));
    expect(getTaskWorkspaceRunDetail).toHaveBeenCalledWith({
      canvasId: baseNavigation.canvasId,
      projectRoot: baseNavigation.projectRoot,
      recordId,
      taskId: baseNavigation.taskId
    });
  });

  it("coalesces in-flight reads and serves later cache hits without reading again", async () => {
    const cache = new TaskWorkspaceRecordCache();
    cache.setAuthority("authority-a");
    const pending = deferred<TaskWorkspaceRunDetail>();
    const read = vi.fn(() => pending.promise);
    const recordId = "T-001#B-001::RUN-001";

    const first = cache.loadRecord(identity(recordId), read);
    const second = cache.loadRecord(identity(recordId), read);
    expect(read).toHaveBeenCalledOnce();
    pending.resolve(detail(recordId));

    await expect(first).resolves.toMatchObject({ key: recordId, status: "ready" });
    await expect(second).resolves.toMatchObject({ key: recordId, status: "ready" });
    await cache.loadRecord(identity(recordId), read);
    expect(read).toHaveBeenCalledOnce();
  });

  it("promotes record hits and evicts the least recently used record", async () => {
    const cache = new TaskWorkspaceRecordCache({ recordCapacity: 2 });
    cache.setAuthority("authority-a");
    const read = vi.fn(async (recordId: string) => detail(recordId));
    const load = (recordId: string) => cache.loadRecord(identity(recordId), () => read(recordId));
    const first = "T-001#B-001::RUN-001";
    const second = "T-001#B-001::RUN-002";
    const third = "T-001#B-001::RUN-003";

    await load(first);
    await load(second);
    expect(cache.getRecord("authority-a", "T-001#B-001", first)).not.toBeNull();
    await load(third);
    await load(second);

    expect(read.mock.calls.map(([recordId]) => recordId)).toEqual([first, second, third, second]);
  });

  it("does not serve a fulfilled record to a different Block selection", async () => {
    const cache = new TaskWorkspaceRecordCache();
    cache.setAuthority("authority-a");
    const recordId = "SHARED::RUN-001";
    const readFirst = vi.fn(async () => detail(recordId, "block one", "T-001#B-001"));
    const readSecond = vi.fn(async () => detail(recordId, "block two", "T-001#B-002"));

    await cache.loadRecord(identity(recordId), readFirst);
    expect(cache.getRecord("authority-a", "T-001#B-002", recordId)).toBeNull();
    const second = await cache.loadRecord(
      identity(recordId, "authority-a", "T-001#B-002"),
      readSecond
    );

    expect(readSecond).toHaveBeenCalledOnce();
    expect(second.blockRef).toBe("T-001#B-002");
    expect(second.record?.stdoutSummary).toBe("block two");
  });

  it("does not coalesce pending reads across different Block selections", async () => {
    const cache = new TaskWorkspaceRecordCache();
    cache.setAuthority("authority-a");
    const recordId = "SHARED::RUN-001";
    const firstDetail = deferred<TaskWorkspaceRunDetail>();
    const secondDetail = deferred<TaskWorkspaceRunDetail>();
    const readFirst = vi.fn(() => firstDetail.promise);
    const readSecond = vi.fn(() => secondDetail.promise);

    const first = cache.loadRecord(identity(recordId), readFirst);
    const second = cache.loadRecord(identity(recordId, "authority-a", "T-001#B-002"), readSecond);
    expect(readFirst).toHaveBeenCalledOnce();
    expect(readSecond).toHaveBeenCalledOnce();
    firstDetail.resolve(detail(recordId, "block one", "T-001#B-001"));
    secondDetail.resolve(detail(recordId, "wrong block", "T-001#B-001"));

    await expect(first).resolves.toMatchObject({ blockRef: "T-001#B-001" });
    await expect(second).rejects.toThrow("does not match its Task Workspace navigation identity");
  });

  it("removes failures and identity mismatches so a later read can retry", async () => {
    const cache = new TaskWorkspaceRecordCache();
    cache.setAuthority("authority-a");
    const recordId = "T-001#B-001::RUN-001";
    const read = vi
      .fn<() => Promise<TaskWorkspaceRunDetail>>()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce({ ...detail(recordId), taskId: "T-OTHER" })
      .mockResolvedValueOnce(detail(recordId));

    await expect(cache.loadRecord(identity(recordId), read)).rejects.toThrow("read failed");
    await expect(cache.loadRecord(identity(recordId), read)).rejects.toThrow(
      "does not match its Task Workspace navigation identity"
    );
    await expect(cache.loadRecord(identity(recordId), read)).resolves.toMatchObject({
      key: recordId,
      status: "ready"
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not cache an old-authority promise that resolves after an authority switch", async () => {
    const cache = new TaskWorkspaceRecordCache();
    const recordId = "T-001#B-001::RUN-001";
    cache.setAuthority("authority-a");
    const oldRead = deferred<TaskWorkspaceRunDetail>();
    const oldRequest = cache.loadRecord(identity(recordId), () => oldRead.promise);

    cache.setAuthority("authority-b");
    const newDetail = deferred<TaskWorkspaceRunDetail>();
    const newRead = vi.fn(() => newDetail.promise);
    const newRequest = cache.loadRecord(identity(recordId, "authority-b"), newRead);
    oldRead.resolve(detail(recordId, "old authority"));
    await oldRequest;
    const coalescedNewRequest = cache.loadRecord(identity(recordId, "authority-b"), newRead);
    expect(newRead).toHaveBeenCalledOnce();
    newDetail.resolve(detail(recordId, "new authority"));
    await Promise.all([newRequest, coalescedNewRequest]);

    expect(cache.getRecord("authority-b", "T-001#B-001", recordId)?.record?.stdoutSummary).toBe(
      "new authority"
    );
    expect(cache.getRecord("authority-a", "T-001#B-001", recordId)).toBeNull();
  });

  it("isolates scroll positions by authority and applies scroll LRU promotion", () => {
    const cache = new TaskWorkspaceRecordCache({ scrollCapacity: 2 });
    cache.setAuthority("authority-a");
    cache.setScrollTop("authority-a", "block-1", "record-1", 10);
    cache.setScrollTop("authority-a", "block-1", "record-2", 20);
    expect(cache.getScrollTop("authority-a", "block-1", "record-1")).toBe(10);
    cache.setScrollTop("authority-a", "block-1", "record-3", 30);

    expect(cache.getScrollTop("authority-a", "block-1", "record-2")).toBe(0);
    expect(cache.getScrollTop("authority-a", "block-1", "record-1")).toBe(10);
    expect(cache.getScrollTop("authority-a", "block-2", "record-1")).toBe(0);
    cache.setAuthority("authority-b");
    expect(cache.getScrollTop("authority-b", "block-1", "record-1")).toBe(0);
    cache.setScrollTop("authority-a", "block-1", "record-1", 40);
    expect(cache.getScrollTop("authority-b", "block-1", "record-1")).toBe(0);
  });
});
