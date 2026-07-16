import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopBridgeInvokeChannels, packageFileChangedChannel } from "../shared/ipcChannels";
import {
  advanceAndFlush,
  cleanupPackageWatchTempRoots,
  createDeferred,
  createWebContents,
  createWorkspace,
  emitNativeWatcherErrors,
  flushDebounce,
  flushMicrotasks,
  forcePollingBackend,
  getPackageWatchMocks,
  registerAndWatch,
  resetPackageWatchTestState,
  unwatch,
  wait,
  waitForPollAndDebounce
} from "./support/packageWatchTestHarness";

const { electronMock, fsMock, fsPromisesMock, runtimeMock } = getPackageWatchMocks();

describe("package file watcher: controller lifecycle", () => {
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

  it("uses native recursive fs.watch when it can be created", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);

    expect(fsMock.watch).toHaveBeenCalledWith(
      workspace.packageDir,
      { recursive: true },
      expect.any(Function)
    );
    expect(fsMock.watchers.length).toBeGreaterThan(0);
    const packageWatcher = fsMock.watchers.find(
      (watcher) => watcher.rootPath === workspace.packageDir
    );
    expect(packageWatcher).toBeDefined();

    packageWatcher?.callback("change", "nodes/T-001/prompt.md");
    await flushDebounce();

    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        projectRoot: workspace.rootPath,
        canvasId: "canvas-a",
        paths: ["package/nodes/T-001/prompt.md"],
        changedPathCount: 1,
        backendKind: "native"
      })
    );
  });

  it("uses non-overlapping native watch roots and keeps the project prompt policy root", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);

    expect(fsMock.watchers.map((watcher) => watcher.rootPath)).toEqual([
      workspace.packageDir,
      dirname(workspace.projectPromptFile)
    ]);
    expect(fsMock.watchers.map((watcher) => watcher.rootPath)).not.toContain(
      join(workspace.packageDir, "nodes")
    );
  });

  it("falls back to polling when recursive watch creation fails", async () => {
    vi.useRealTimers();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("recursive watch unsupported");
    });

    await registerAndWatch(webContents, workspace);

    expect(fsMock.watch).toHaveBeenCalledTimes(1);
    await writePromptChange(workspace);
    await waitForPollAndDebounce();

    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: ["package/nodes/T-001/blocks/B-001.prompt.md"],
        changedPathCount: 1,
        backendKind: "polling"
      })
    );
  });

  it("debounces multiple native watcher changes into one event", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);
    const packageWatcher = fsMock.watchers.find(
      (watcher) => watcher.rootPath === workspace.packageDir
    );
    expect(packageWatcher).toBeDefined();

    packageWatcher?.callback("change", "manifest.json");
    packageWatcher?.callback("change", "nodes/T-001/prompt.md");
    await vi.advanceTimersByTimeAsync(149);
    expect(webContents.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(webContents.send).toHaveBeenCalledTimes(1);
    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: ["package/manifest.json", "package/nodes/T-001/prompt.md"],
        changedPathCount: 2,
        backendKind: "native"
      })
    );
  });

  it("normalizes, dedupes, and sorts debounced native watcher paths", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);
    const packageWatcher = fsMock.watchers.find(
      (watcher) => watcher.rootPath === workspace.packageDir
    );
    expect(packageWatcher).toBeDefined();

    packageWatcher?.callback("change", "nodes/T-001/prompt.md");
    packageWatcher?.callback("change", "nodes\\T-001\\prompt.md\\");
    packageWatcher?.callback("change", "manifest.json");
    await flushDebounce();

    expect(webContents.send).toHaveBeenCalledTimes(1);
    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: ["package/manifest.json", "package/nodes/T-001/prompt.md"],
        changedPathCount: 2,
        backendKind: "native"
      })
    );
  });

  it("stops native watchers and polling timers after unwatch", async () => {
    const nativeWorkspace = await createWorkspace();
    const nativeWebContents = createWebContents(1);

    await registerAndWatch(nativeWebContents, nativeWorkspace);
    await unwatch(nativeWebContents, nativeWorkspace);

    expect(fsMock.watchers.length).toBeGreaterThan(0);
    for (const watcher of fsMock.watchers) {
      expect(watcher.close).toHaveBeenCalled();
    }

    vi.resetModules();
    vi.useRealTimers();
    electronMock.handlers.clear();
    fsMock.watchers.length = 0;
    fsMock.watch.mockClear();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("recursive watch unsupported");
    });

    const pollingWorkspace = await createWorkspace();
    const pollingWebContents = createWebContents(2);
    await registerAndWatch(pollingWebContents, pollingWorkspace);
    await unwatch(pollingWebContents, pollingWorkspace);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(pollingWorkspace.packageDir, "nodes", "T-001", "prompt.md"),
      "changed after unwatch\n",
      "utf8"
    );
    await waitForPollAndDebounce();

    expect(pollingWebContents.send).not.toHaveBeenCalled();
  });

  it("does not duplicate native watchers or destroyed listeners for the same webContents", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);
    const nativeWatcherCount = fsMock.watchers.length;
    const destroyedListener = webContents.once.mock.calls[0]?.[1];

    await registerAndWatch(webContents, workspace);

    expect(fsMock.watchers).toHaveLength(nativeWatcherCount);
    expect(webContents.once).toHaveBeenCalledTimes(1);
    expect(webContents.once).toHaveBeenCalledWith("destroyed", destroyedListener);

    await unwatch(webContents, workspace);

    expect(webContents.removeListener).toHaveBeenCalledTimes(1);
    expect(webContents.removeListener).toHaveBeenCalledWith("destroyed", destroyedListener);
    for (const watcher of fsMock.watchers) {
      expect(watcher.close).toHaveBeenCalledTimes(1);
    }
  });

  it("single-flights concurrent watches for the same webContents and key", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const deferredWorkspace = createDeferred<typeof workspace>();
    runtimeMock.state.workspace = workspace;
    runtimeMock.resolveTaskCanvasWorkspace.mockImplementationOnce(() => deferredWorkspace.promise);
    const { registerPackageWatchHandlers } = await import("../main/packageWatch");
    registerPackageWatchHandlers();
    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.watchPackageFiles);
    expect(handler).toBeDefined();

    const firstWatch = handler?.(
      { sender: webContents },
      { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
    );
    const secondWatch = handler?.(
      { sender: webContents },
      { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
    );

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledTimes(1);
    deferredWorkspace.resolve(workspace);
    await Promise.all([firstWatch, secondWatch]);

    const destroyedListener = webContents.once.mock.calls[0]?.[1] as (() => void) | undefined;
    expect(fsMock.watchers.length).toBeGreaterThan(0);
    expect(new Set(fsMock.watchers.map((watcher) => watcher.rootPath)).size).toBe(
      fsMock.watchers.length
    );
    expect(fsMock.watch).toHaveBeenCalledTimes(fsMock.watchers.length);
    expect(webContents.once).toHaveBeenCalledTimes(1);
    expect(webContents.once).toHaveBeenCalledWith("destroyed", destroyedListener);

    destroyedListener?.();

    expect(webContents.removeListener).toHaveBeenCalledTimes(1);
    expect(webContents.removeListener).toHaveBeenCalledWith("destroyed", destroyedListener);
    for (const watcher of fsMock.watchers) {
      expect(watcher.close).toHaveBeenCalledTimes(1);
    }
  });

  it("closes the backend without a destroyed listener when unwatch cancels a pending watch", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const deferredWorkspace = createDeferred<typeof workspace>();
    runtimeMock.state.workspace = workspace;
    runtimeMock.resolveTaskCanvasWorkspace.mockImplementationOnce(() => deferredWorkspace.promise);
    const { registerPackageWatchHandlers } = await import("../main/packageWatch");
    registerPackageWatchHandlers();
    const watchHandler = electronMock.handlers.get(desktopBridgeInvokeChannels.watchPackageFiles);
    expect(watchHandler).toBeDefined();

    const watchResult = watchHandler?.(
      { sender: webContents },
      { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
    );

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledTimes(1);
    await unwatch(webContents, workspace);
    expect(webContents.once).not.toHaveBeenCalled();

    deferredWorkspace.resolve(workspace);
    await watchResult;

    expect(fsMock.watchers.length).toBeGreaterThan(0);
    for (const watcher of fsMock.watchers) {
      expect(watcher.close).toHaveBeenCalledTimes(1);
    }
    expect(webContents.once).not.toHaveBeenCalled();
    expect(webContents.removeListener).not.toHaveBeenCalled();

    const packageWatcher = fsMock.watchers.find(
      (watcher) => watcher.rootPath === workspace.packageDir
    );
    expect(packageWatcher).toBeDefined();
    packageWatcher?.callback("change", "manifest.json");
    await flushDebounce();

    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("cleans pending subscribers when pending watch creation fails", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const deferredWorkspace = createDeferred<typeof workspace>();
    runtimeMock.state.workspace = workspace;
    runtimeMock.resolveTaskCanvasWorkspace.mockImplementationOnce(() => deferredWorkspace.promise);
    const { registerPackageWatchHandlers } = await import("../main/packageWatch");
    registerPackageWatchHandlers();
    const watchHandler = electronMock.handlers.get(desktopBridgeInvokeChannels.watchPackageFiles);
    expect(watchHandler).toBeDefined();

    const failedWatch = watchHandler?.(
      { sender: webContents },
      { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
    );
    deferredWorkspace.reject(new Error("workspace unavailable"));
    await expect(failedWatch).rejects.toThrow("workspace unavailable");

    await registerAndWatch(webContents, workspace);

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledTimes(2);
    expect(webContents.once).toHaveBeenCalledTimes(1);
    expect(fsMock.watchers.length).toBeGreaterThan(0);
  });

  it("on native runtime error after start, keeps subscribers, closes native, switches to exactly one poller and updates backendKind", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);

    expect(fsMock.watch).toHaveBeenCalled();
    const nativeWatchers = [...fsMock.watchers];
    expect(nativeWatchers.length).toBeGreaterThan(0);

    emitNativeWatcherErrors(nativeWatchers, new Error("native watcher runtime failure"));
    // Drain polling baseline I/O (real fs) + kickoff timers under fake clock.
    await flushMicrotasks();
    await advanceAndFlush(700);
    await flushDebounce();

    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "native errored then polling edit\n",
      "utf8"
    );
    await advanceAndFlush(2200);
    await flushDebounce();

    const calls = webContents.send.mock.calls.filter((c) => c[0] === packageFileChangedChannel);
    expect(calls.length).toBeGreaterThan(0);
    const lastPayload = calls[calls.length - 1][1];
    expect(lastPayload.backendKind).toBe("polling");

    for (const w of nativeWatchers) {
      expect(w.close).toHaveBeenCalledTimes(1);
    }
  });

  it("concurrent or repeated native errors produce at most one poller; old generation late changes are ignored", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);

    const nativeWs = [...fsMock.watchers];
    expect(nativeWs.length).toBeGreaterThan(1);

    // Snapshot handlers before close/removeAllListeners; hold polling bootstrap so install is delayed.
    const allErrorHandlers = nativeWs.flatMap((w) => [...w.errorHandlers]);
    expect(allErrorHandlers.length).toBeGreaterThan(0);
    const deferredStat = createDeferred<void>();
    fsPromisesMock.state.holdStatPromise = deferredStat.promise;

    for (const handler of allErrorHandlers) {
      handler(new Error("err1"));
    }
    for (const handler of allErrorHandlers) {
      handler(new Error("err2"));
    }
    await flushMicrotasks();

    // Late native generation change while failover is pending — must not publish.
    webContents.send.mockClear();
    nativeWs[0]?.callback("change", "nodes/T-001/prompt.md");
    await flushDebounce();
    expect(webContents.send).not.toHaveBeenCalled();

    for (const w of nativeWs) {
      expect(w.close).toHaveBeenCalledTimes(1);
    }
    // No additional native watchers created by repeated errors.
    expect(fsMock.watchers.length).toBe(nativeWs.length);

    deferredStat.resolve();
    fsPromisesMock.state.holdStatPromise = null;
    // Allow polling baseline + kickoff install to finish under fake timers + real fs.
    await advanceAndFlush(700);
    await flushDebounce();

    webContents.send.mockClear();
    // Old native path still ignored after poller is live.
    nativeWs[0]?.callback("change", "nodes/T-001/prompt.md");
    await flushDebounce();
    expect(webContents.send).not.toHaveBeenCalled();

    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(workspace.packageDir, "manifest.json"),
      JSON.stringify({ version: "plan-package/v1", bumped: true }),
      "utf8"
    );
    await advanceAndFlush(2200);
    await flushDebounce();

    const pollingCalls = webContents.send.mock.calls.filter(
      (c) => c[0] === packageFileChangedChannel
    );
    expect(pollingCalls.length).toBeGreaterThan(0);
    expect(pollingCalls[pollingCalls.length - 1][1].backendKind).toBe("polling");

    // Still exactly one close per native watcher; no second native generation.
    for (const w of nativeWs) {
      expect(w.close).toHaveBeenCalledTimes(1);
    }
    expect(fsMock.watchers.length).toBe(nativeWs.length);
  });

  it("native error then immediate unwatch closes each native watcher once; delayed poller closes with zero timers and no late publish", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);
    const nativeWs = [...fsMock.watchers];
    expect(nativeWs.length).toBeGreaterThan(0);

    // Delay polling backend start (fingerprint baseline uses stat).
    const deferredStat = createDeferred<void>();
    fsPromisesMock.state.holdStatPromise = deferredStat.promise;

    emitNativeWatcherErrors(nativeWs, new Error("native runtime failure during failover"));
    await flushMicrotasks();

    // Last subscriber leaves while polling Promise is still pending.
    await unwatch(webContents, workspace);
    await flushMicrotasks();

    for (const w of nativeWs) {
      expect(w.close).toHaveBeenCalledTimes(1);
    }

    webContents.send.mockClear();
    deferredStat.resolve();
    fsPromisesMock.state.holdStatPromise = null;
    await flushMicrotasks();
    await advanceAndFlush(30_000);
    await flushDebounce();

    expect(webContents.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // Native close remains exactly once even after delayed poller settle path runs.
    for (const w of nativeWs) {
      expect(w.close).toHaveBeenCalledTimes(1);
    }
  });

  it("last subscriber leave stops native watchers and polling timers with zero active timers", async () => {
    const nativeWorkspace = await createWorkspace();
    const w1 = createWebContents(1);
    await registerAndWatch(w1, nativeWorkspace);
    await unwatch(w1, nativeWorkspace);

    for (const watcher of fsMock.watchers) {
      expect(watcher.close).toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);

    vi.resetModules();
    electronMock.handlers.clear();
    fsMock.watchers.length = 0;
    fsMock.watch.mockClear();
    forcePollingBackend();

    const pollWs = await createWorkspace();
    const w2 = createWebContents(2);
    await registerAndWatch(w2, pollWs);
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await unwatch(w2, pollWs);
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(0);

    const { writeFile } = await import("node:fs/promises");
    const afterPath = join(pollWs.packageDir, "nodes", "T-001", "prompt.md");
    await writeFile(afterPath, "after last unwatch\n", "utf8");
    await advanceAndFlush(30_000);
    await flushDebounce();
    expect(w2.send).not.toHaveBeenCalled();
  });
});

async function writePromptChange(
  workspace: Awaited<ReturnType<typeof createWorkspace>>
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"),
    "changed block prompt\n",
    "utf8"
  );
}
