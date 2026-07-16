import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packageFileChangedChannel } from "../shared/ipcChannels";
import {
  advanceAndFlush,
  cleanupPackageWatchTempRoots,
  createDeferred,
  createWebContents,
  createWorkspace,
  emitNativeWatcherErrors,
  flushDebounce,
  flushMicrotasks,
  getPackageWatchMocks,
  registerAndWatch,
  resetPackageWatchTestState,
  unwatch
} from "./support/packageWatchTestHarness";

const { fsMock, fsPromisesMock } = getPackageWatchMocks();

describe("package file watcher: controller identity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]
    });
    resetPackageWatchTestState();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupPackageWatchTempRoots();
  });

  it("does not let a closed controller publish or install its pending poller into a replacement", async () => {
    const workspace = await createWorkspace();
    const subscriberA = createWebContents(1);

    await registerAndWatch(subscriberA, workspace);
    const nativeA = [...fsMock.watchers];
    const lateErrorHandlersA = nativeA.flatMap((watcher) => [...watcher.errorHandlers]);
    expect(nativeA.length).toBeGreaterThan(0);

    const deferredStat = createDeferred<void>();
    fsPromisesMock.state.holdStatPromise = deferredStat.promise;
    emitNativeWatcherErrors(nativeA, new Error("controller A native failure"));
    await flushMicrotasks();

    await unwatch(subscriberA, workspace);
    for (const watcher of nativeA) {
      expect(watcher.close).toHaveBeenCalledTimes(1);
    }
    expect(vi.getTimerCount()).toBe(0);

    const subscriberB = createWebContents(2);
    await registerAndWatch(subscriberB, workspace);
    const nativeB = fsMock.watchers.slice(nativeA.length);
    const activeBackendCount = () =>
      [nativeA, nativeB].filter((watchers) =>
        watchers.some((watcher) => watcher.close.mock.calls.length === 0)
      ).length + (vi.getTimerCount() > 0 ? 1 : 0);
    expect(nativeB.length).toBeGreaterThan(0);
    for (const watcher of nativeB) {
      expect(watcher.close).not.toHaveBeenCalled();
    }
    expect(activeBackendCount()).toBe(1);

    subscriberB.send.mockClear();
    nativeA[0]?.callback("change", "nodes/T-001/prompt.md");
    for (const handler of lateErrorHandlersA) {
      handler(new Error("controller A late native failure"));
    }
    await flushDebounce();
    expect(subscriberB.send).not.toHaveBeenCalled();

    await writeFile(
      join(workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "changed while controller A polling bootstrap is pending\n",
      "utf8"
    );
    deferredStat.resolve();
    fsPromisesMock.state.holdStatPromise = null;
    await flushMicrotasks();

    // A's completed polling adapter is closed instead of replacing B's active native adapter.
    expect(vi.getTimerCount()).toBe(0);
    for (const watcher of nativeB) {
      expect(watcher.close).not.toHaveBeenCalled();
    }
    expect(activeBackendCount()).toBe(1);
    await advanceAndFlush(30_000);
    await flushDebounce();
    expect(subscriberB.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    nativeB[0]?.callback("change", "manifest.json");
    await flushDebounce();
    expect(subscriberB.send).toHaveBeenCalledTimes(1);
    expect(subscriberB.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({ backendKind: "native", paths: ["package/manifest.json"] })
    );

    await unwatch(subscriberB, workspace);
    for (const watcher of nativeA) {
      expect(watcher.close).toHaveBeenCalledTimes(1);
      expect(watcher.errorHandlers).toHaveLength(0);
    }
    for (const watcher of nativeB) {
      expect(watcher.close).toHaveBeenCalledTimes(1);
      expect(watcher.errorHandlers).toHaveLength(0);
    }
    expect(subscriberA.removeListener).toHaveBeenCalledTimes(1);
    expect(subscriberB.removeListener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(activeBackendCount()).toBe(0);
  });
});
