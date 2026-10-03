import { readFile, utimes, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeStateChangedChannel } from "../shared/ipcChannels";
import {
  electronMock,
  fsMock,
  fsPromisesMock,
  runtimeMock,
  tempRoots,
  activeWatches,
  watchRuntimeDriver,
  createDeferred,
  createWorkspace,
  createWebContents,
  registerAndWatch,
  unwatch,
  flushDebounce,
  advanceUntilStateStat,
  advanceUntilFingerprint,
  advanceUntilReadFileCall
} from "./support/runtimeStateWatchTestHarness.js";

describe("runtime state watcher", () => {
  beforeEach(() => {
    vi.resetModules();
    watchRuntimeDriver.reset();
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
    fsMock.watchers.length = 0;
    fsMock.watch.mockClear();
    fsPromisesMock.reset();
    runtimeMock.state.workspace = null;
    runtimeMock.resolveTaskCanvasWorkspace.mockClear();
  });

  afterEach(async () => {
    for (const { webContents, workspace } of activeWatches.splice(0)) {
      await unwatch(webContents, workspace);
    }
    await Promise.all(
      tempRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true }))
    );
  });

  it.each([
    "queued",
    "native"
  ])("fails over %s native errors once and continues actual state notifications", async (failureKind) => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await registerAndWatch(webContents, workspace);
      const watcher = fsMock.watchers[0];
      expect(() => {
        if (failureKind === "native") watcher.nativeFailure(new Error("native watch lost"));
        else watcher.emit("error", new Error("native watch lost"));
      }).not.toThrow();
      expect(() => watcher.emit("error", new Error("queued second error"))).not.toThrow();
      expect(watcher.close).toHaveBeenCalledTimes(1);
      expect(watchRuntimeDriver.pendingTimerCount()).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("native watch lost");
      expect(webContents.send).not.toHaveBeenCalled();
      fsPromisesMock.state.readFileCalls = 0;
      await advanceUntilStateStat(1000, workspace.stateFile);
      expect(fsPromisesMock.state.readFileCalls).toBe(0);
      await writeFile(workspace.stateFile, JSON.stringify({ version: 2, tasks: { done: true } }));
      await advanceUntilStateStat(1000, workspace.stateFile);
      await advanceUntilFingerprint(150, workspace.stateFile);
      expect(webContents.send).toHaveBeenCalledTimes(1);
      await advanceUntilStateStat(850, workspace.stateFile);
      expect(webContents.send).toHaveBeenCalledTimes(1);
      await unwatch(webContents, workspace);
      expect(watchRuntimeDriver.pendingTimerCount()).toBe(0);
      await watchRuntimeDriver.advanceByAndDrain(60_000);
      expect(webContents.send).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("transfers a failed fingerprint retry across failover and ignores a cancelled old callback", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduled = vi.spyOn(watchRuntimeDriver, "schedule");
    try {
      await registerAndWatch(webContents, workspace);
      await writeFile(
        workspace.stateFile,
        JSON.stringify({ version: 2, tasks: { recovered: true } })
      );
      fsPromisesMock.state.readFileHook = () => {
        throw new Error("temporary fingerprint read failure");
      };
      fsMock.watchers[0].callback("change", "state.json");
      await flushDebounce();
      expect(webContents.send).not.toHaveBeenCalled();
      expect(watchRuntimeDriver.pendingTimerCount()).toBe(1);
      const oldRetry = scheduled.mock.calls.at(-1)![1];
      fsMock.watchers[0].nativeFailure(new Error("native backend failure during retry"));
      expect(watchRuntimeDriver.pendingTimerCount()).toBe(3);
      await oldRetry();
      expect(watchRuntimeDriver.pendingTimerCount()).toBe(3);
      fsPromisesMock.state.readFileHook = null;
      await watchRuntimeDriver.advanceByAndDrain(999);
      expect(webContents.send).not.toHaveBeenCalled();
      await watchRuntimeDriver.advanceByAndDrain(1);
      expect(webContents.send).toHaveBeenCalledTimes(1);
      await watchRuntimeDriver.advanceByAndDrain(1150);
      expect(webContents.send).toHaveBeenCalledTimes(1);
      expect(fsPromisesMock.state.maxActiveReadFiles).toBe(1);
      await unwatch(webContents, workspace);
      expect(watchRuntimeDriver.pendingTimerCount()).toBe(0);
      await oldRetry();
      await watchRuntimeDriver.advanceByAndDrain(60_000);
      expect(webContents.send).toHaveBeenCalledTimes(1);
      expect(watchRuntimeDriver.pendingTimerCount()).toBe(0);
    } finally {
      warn.mockRestore();
      scheduled.mockRestore();
    }
  });

  it("retains shared polling until the last subscriber closes and releases normal close listeners", async () => {
    const workspace = await createWorkspace();
    const first = createWebContents(1);
    const second = createWebContents(2);
    await registerAndWatch(first, workspace);
    await registerAndWatch(second, workspace);
    const watcher = fsMock.watchers[0];
    watcher.emit("error", new Error("lost native watch"));
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(watcher.listenerCount("error")).toBe(0);
    await unwatch(first, workspace);
    expect(watchRuntimeDriver.pendingTimerCount()).toBe(2);
    await writeFile(workspace.stateFile, JSON.stringify({ version: 2, tasks: { shared: true } }));
    await advanceUntilStateStat(1000, workspace.stateFile);
    await advanceUntilFingerprint(150, workspace.stateFile);
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalledTimes(1);
    await unwatch(second, workspace);
    expect(watchRuntimeDriver.pendingTimerCount()).toBe(0);
  });

  it("does not revive polling when unwatch runs during native failover close", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    await registerAndWatch(webContents, workspace);
    const watcher = fsMock.watchers[0];
    const close = watcher.close.getMockImplementation();
    watcher.close.mockImplementation(() => {
      close?.();
      void unwatch(webContents, workspace);
    });
    watcher.emit("error", new Error("native close interleaving"));
    expect(watchRuntimeDriver.pendingTimerCount()).toBe(0);
    watcher.callback("change", "state.json");
    watcher.emit("error", new Error("late error before close event"));
    await watchRuntimeDriver.advanceByAndDrain(60_000);
    expect(webContents.send).not.toHaveBeenCalled();
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(watchRuntimeDriver.pendingTimerCount()).toBe(0);
  });

  it("ignores retired native callbacks after another subscription replaces the instance", async () => {
    const workspace = await createWorkspace();
    const first = createWebContents(1);
    await registerAndWatch(first, workspace);
    const oldWatcher = fsMock.watchers[0];
    await unwatch(first, workspace);
    const second = createWebContents(2);
    await registerAndWatch(second, workspace);
    await writeFile(workspace.stateFile, JSON.stringify({ version: 2, tasks: { replaced: true } }));
    oldWatcher.callback("change", "state.json");
    await flushDebounce();
    expect(second.send).not.toHaveBeenCalled();
    fsMock.watchers[1].callback("change", "state.json");
    await advanceUntilFingerprint(150, workspace.stateFile);
    expect(second.send).toHaveBeenCalledTimes(1);
  });

  it("discards old native scans across failover then publishes through current polling", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const replacement = Buffer.from(JSON.stringify({ version: 2, tasks: { current: true } }));
    await registerAndWatch(webContents, workspace);
    await writeFile(workspace.stateFile, replacement);
    const held = createDeferred<Buffer>();
    const started = createDeferred<void>();
    fsPromisesMock.state.readFileHook = (path) => {
      if (path === workspace.stateFile) {
        started.resolve();
        return held.promise;
      }
    };
    const watcher = fsMock.watchers[0];
    watcher.callback("change", "state.json");
    watchRuntimeDriver.advanceBy(150);
    await started.promise;
    watcher.nativeFailure(new Error("failed during scan"));
    watcher.callback("change", "state.json");
    held.resolve(replacement);
    fsPromisesMock.state.readFileHook = null;
    await watchRuntimeDriver.drain();
    expect(webContents.send).not.toHaveBeenCalled();
    await advanceUntilStateStat(1000, workspace.stateFile);
    await advanceUntilFingerprint(150, workspace.stateFile);
    expect(webContents.send).toHaveBeenCalledTimes(1);
  });

  it("closes pending native startup when its subscription was removed", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const held = createDeferred<Buffer>();
    const started = createDeferred<void>();
    const content = await readFile(workspace.stateFile);
    fsPromisesMock.state.readFileHook = (path) => {
      if (path === workspace.stateFile) {
        started.resolve();
        return held.promise;
      }
    };
    const pending = registerAndWatch(webContents, workspace);
    await started.promise;
    await unwatch(webContents, workspace);
    held.resolve(content);
    fsPromisesMock.state.readFileHook = null;
    await pending;
    expect(fsMock.watchers[0].close).toHaveBeenCalledTimes(1);
    expect(watchRuntimeDriver.pendingTimerCount()).toBe(0);
    fsMock.watchers[0].emit("error", new Error("queued during startup close"));
    await flushDebounce();
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("does not publish an in-flight polling metadata scan or revive timers after unwatch", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    await registerAndWatch(webContents, workspace);
    fsMock.watchers[0].nativeFailure(new Error("start polling"));
    await writeFile(workspace.stateFile, JSON.stringify({ version: 2, tasks: { changed: true } }));
    const observed = createDeferred<void>();
    fsPromisesMock.state.statResultHook = (path) => {
      if (path === workspace.stateFile) {
        void unwatch(webContents, workspace);
        observed.resolve();
      }
    };
    watchRuntimeDriver.advanceBy(1000);
    await observed.promise;
    fsPromisesMock.state.statResultHook = null;
    await watchRuntimeDriver.drain();
    await watchRuntimeDriver.advanceByAndDrain(60_000);
    expect(webContents.send).not.toHaveBeenCalled();
    expect(watchRuntimeDriver.pendingTimerCount()).toBe(0);
  });

  it("reclaims its allocated native handle when listener initialization fails", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const createWatcher = fsMock.watch.getMockImplementation();
    if (!createWatcher) throw new Error("Missing watcher fixture implementation.");
    fsMock.watch.mockImplementationOnce((root, options, callback) => {
      const watcher = createWatcher(root, options, callback);
      const on = watcher.on.bind(watcher);
      vi.spyOn(watcher, "on").mockImplementation((event, listener) => {
        if (event === "error") throw new Error("native listener setup failed");
        return on(event, listener);
      });
      return watcher;
    });
    await registerAndWatch(webContents, workspace);
    expect(fsMock.watchers[0].close).toHaveBeenCalledTimes(1);
    expect(watchRuntimeDriver.pendingTimerCount()).toBe(2);
    await writeFile(
      workspace.stateFile,
      JSON.stringify({ version: 2, tasks: { recovered: true } })
    );
    await advanceUntilStateStat(1000, workspace.stateFile);
    await advanceUntilFingerprint(150, workspace.stateFile);
    expect(webContents.send).toHaveBeenCalledTimes(1);
    await unwatch(webContents, workspace);
    expect(watchRuntimeDriver.pendingTimerCount()).toBe(0);
  });

  it("notifies subscribers when the current canvas state file changes", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);

    expect(fsMock.watch).toHaveBeenCalledWith(
      join(workspace.rootPath, "canvases", "canvas-a"),
      { recursive: false },
      expect.any(Function)
    );
    const watcher = fsMock.watchers[0];
    expect(watcher).toBeDefined();

    await writeFile(
      workspace.stateFile,
      JSON.stringify({ version: 1, tasks: { "T-001": "done" } }),
      "utf8"
    );
    watcher?.callback("change", "state.json");
    await watchRuntimeDriver.advanceByAndDrain(250);

    expect(webContents.send).toHaveBeenCalledWith(
      runtimeStateChangedChannel,
      expect.objectContaining({
        projectRoot: workspace.rootPath,
        canvasId: "canvas-a",
        stateFile: workspace.stateFile,
        changedAt: expect.any(String)
      })
    );
  });

  it("does not notify for non-state files in the watched directory", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);
    fsMock.watchers[0]?.callback("change", "manifest.json");
    await flushDebounce();

    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("stops native watchers after unwatch", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);
    await unwatch(webContents, workspace);

    expect(fsMock.watchers[0]?.close).toHaveBeenCalled();
    await writeFile(
      workspace.stateFile,
      JSON.stringify({ version: 1, tasks: { "T-001": "done" } }),
      "utf8"
    );
    fsMock.watchers[0]?.callback("change", "state.json");
    await flushDebounce();

    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("polling fallback detects metadata changes without hashing unchanged ticks", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("native watch unsupported");
    });

    await registerAndWatch(webContents, workspace);
    fsPromisesMock.state.readFileCalls = 0;
    await advanceUntilStateStat(1000, workspace.stateFile);
    expect(fsPromisesMock.state.readFileCalls).toBe(0);

    await writeFile(
      workspace.stateFile,
      JSON.stringify({ version: 2, tasks: { "T-001": "completed" } }),
      "utf8"
    );
    await advanceUntilStateStat(1000, workspace.stateFile);
    await advanceUntilFingerprint(150, workspace.stateFile);

    expect(webContents.send).toHaveBeenCalledWith(
      runtimeStateChangedChannel,
      expect.objectContaining({
        projectRoot: workspace.rootPath,
        canvasId: "canvas-a",
        stateFile: workspace.stateFile
      })
    );
    expect(fsPromisesMock.state.readFileCalls).toBe(1);
  });

  it.each([
    "startup",
    "async"
  ])("%s polling hash sweep detects same-size same-mtime edits", async (failureKind) => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const pinned = new Date("2020-01-01T00:00:00.000Z");
    await utimes(workspace.stateFile, pinned, pinned);
    if (failureKind === "startup") {
      fsMock.watch.mockImplementationOnce(() => {
        throw new Error("native watch unsupported");
      });
    }

    await registerAndWatch(webContents, workspace);
    if (failureKind === "async")
      fsMock.watchers[0].nativeFailure(new Error("native hash fallback"));
    const original = await readFile(workspace.stateFile);
    const replacement = Buffer.alloc(original.length, 0x20);
    await writeFile(workspace.stateFile, replacement);
    await utimes(workspace.stateFile, pinned, pinned);

    await watchRuntimeDriver.advanceByAndDrain(29_000);
    expect(webContents.send).not.toHaveBeenCalled();

    await watchRuntimeDriver.advanceByAndDrain(1000);
    await advanceUntilFingerprint(150, workspace.stateFile);
    expect(webContents.send).toHaveBeenCalledTimes(1);
  });

  it("keeps slow fingerprint reads single-flight across polling sweeps", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const heldRead = createDeferred<Buffer>();
    const readStarted = createDeferred<void>();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("native watch unsupported");
    });

    await registerAndWatch(webContents, workspace);
    fsPromisesMock.state.readFileCalls = 0;
    fsPromisesMock.state.maxActiveReadFiles = 0;
    fsPromisesMock.state.readFileHook = (path) => {
      if (path === workspace.stateFile) {
        readStarted.resolve();
        return heldRead.promise;
      }
    };

    watchRuntimeDriver.advanceBy(30_150);
    await readStarted.promise;
    watchRuntimeDriver.advanceBy(60_000);

    expect(fsPromisesMock.state.readFileCalls).toBe(1);
    expect(fsPromisesMock.state.maxActiveReadFiles).toBe(1);
    heldRead.resolve(Buffer.from("stale"));
    fsPromisesMock.state.readFileHook = null;
    await watchRuntimeDriver.drain();
  });

  it("does not publish an in-flight fingerprint after unwatch", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const replacement = Buffer.from(JSON.stringify({ version: 2, tasks: {} }));
    const heldRead = createDeferred<Buffer>();
    const readStarted = createDeferred<void>();

    await registerAndWatch(webContents, workspace);
    await writeFile(workspace.stateFile, replacement);
    fsPromisesMock.state.readFileHook = (path) => {
      if (path === workspace.stateFile) {
        readStarted.resolve();
        return heldRead.promise;
      }
    };
    fsMock.watchers[0]?.callback("change", "state.json");
    watchRuntimeDriver.advanceBy(150);
    await readStarted.promise;

    await unwatch(webContents, workspace);
    heldRead.resolve(replacement);
    fsPromisesMock.state.readFileHook = null;
    await watchRuntimeDriver.drain();

    expect(webContents.send).not.toHaveBeenCalled();
    expect(watchRuntimeDriver.pendingTimerCount()).toBe(0);
  });

  it("keeps fingerprint retry deadlines under a native event storm and resets after recovery", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await registerAndWatch(webContents, workspace);
      await writeFile(
        workspace.stateFile,
        JSON.stringify({ version: 2, tasks: { "T-001": "completed" } }),
        "utf8"
      );
      fsPromisesMock.state.readFileCalls = 0;
      fsPromisesMock.state.readFileHook = (path) => {
        if (path === workspace.stateFile) {
          throw new Error("simulated fingerprint failure");
        }
      };

      fsMock.watchers[0]?.callback("change", "state.json");
      await advanceUntilReadFileCall(150, workspace.stateFile, 1);
      expect(fsPromisesMock.state.readFileCalls).toBe(1);

      for (let index = 0; index < 9; index += 1) {
        fsMock.watchers[0]?.callback("change", "state.json");
        await watchRuntimeDriver.advanceByAndDrain(100);
      }
      await watchRuntimeDriver.advanceByAndDrain(99);
      expect(fsPromisesMock.state.readFileCalls).toBe(1);

      await advanceUntilReadFileCall(1, workspace.stateFile, 2);
      expect(fsPromisesMock.state.readFileCalls).toBe(2);

      fsPromisesMock.state.readFileHook = null;
      for (let index = 0; index < 19; index += 1) {
        fsMock.watchers[0]?.callback("change", "state.json");
        await watchRuntimeDriver.advanceByAndDrain(100);
      }
      await watchRuntimeDriver.advanceByAndDrain(99);
      expect(fsPromisesMock.state.readFileCalls).toBe(2);

      await advanceUntilFingerprint(1, workspace.stateFile);
      expect(webContents.send).toHaveBeenCalledTimes(1);

      await writeFile(
        workspace.stateFile,
        JSON.stringify({ version: 3, tasks: { "T-001": "completed", "T-002": "ready" } }),
        "utf8"
      );
      fsPromisesMock.state.readFileHook = (path) => {
        if (path === workspace.stateFile) {
          throw new Error("simulated fingerprint failure after recovery");
        }
      };
      const callsBeforeRecoveredFailure = fsPromisesMock.state.readFileCalls;
      fsMock.watchers[0]?.callback("change", "state.json");
      await advanceUntilReadFileCall(150, workspace.stateFile, callsBeforeRecoveredFailure + 1);
      expect(fsPromisesMock.state.readFileCalls).toBe(callsBeforeRecoveredFailure + 1);

      for (let index = 0; index < 9; index += 1) {
        fsMock.watchers[0]?.callback("change", "state.json");
        await watchRuntimeDriver.advanceByAndDrain(100);
      }
      await watchRuntimeDriver.advanceByAndDrain(99);
      expect(fsPromisesMock.state.readFileCalls).toBe(callsBeforeRecoveredFailure + 1);
      await advanceUntilReadFileCall(1, workspace.stateFile, callsBeforeRecoveredFailure + 2);
      expect(fsPromisesMock.state.readFileCalls).toBe(callsBeforeRecoveredFailure + 2);
      expect(webContents.send).toHaveBeenCalledTimes(1);
    } finally {
      fsPromisesMock.state.readFileHook = null;
      await unwatch(webContents, workspace);
      warnSpy.mockRestore();
    }
  });

  it("backs off repeated polling failures and resumes fast probes after recovery", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("native watch unsupported");
    });

    try {
      await registerAndWatch(webContents, workspace);
      warnSpy.mockClear();
      fsPromisesMock.state.failStat = true;

      await watchRuntimeDriver.advanceByAndDrain(1000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      await watchRuntimeDriver.advanceByAndDrain(1000);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      await watchRuntimeDriver.advanceByAndDrain(1000);
      expect(warnSpy).toHaveBeenCalledTimes(2);

      fsPromisesMock.state.failStat = false;
      await advanceUntilStateStat(1000, workspace.stateFile);
      await writeFile(
        workspace.stateFile,
        JSON.stringify({ version: 3, tasks: { recovered: true } }),
        "utf8"
      );
      await advanceUntilStateStat(1000, workspace.stateFile);
      await advanceUntilFingerprint(150, workspace.stateFile);

      expect(webContents.send).toHaveBeenCalledTimes(1);
    } finally {
      fsPromisesMock.state.failStat = false;
      warnSpy.mockRestore();
    }
  });
});
