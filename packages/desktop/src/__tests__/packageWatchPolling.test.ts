import { mkdir, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packageFileChangedChannel } from "../shared/ipcChannels";
import {
  advanceAndFlush,
  cleanupPackageWatchTempRoots,
  createDeferred,
  createWebContents,
  createWorkspace,
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

const { fsMock, fsPromisesMock } = getPackageWatchMocks();

describe("package file watcher: polling SLA and resources", () => {
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

  it("detects size-changing prompt edits from polling snapshots without content hashing", async () => {
    vi.useRealTimers();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("recursive watch unsupported");
    });

    await registerAndWatch(webContents, workspace);
    const promptPath = join(workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md");
    await writeFile(promptPath, "changed block prompt with a longer body\n", "utf8");
    await waitForPollAndDebounce();

    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: ["package/nodes/T-001/blocks/B-001.prompt.md"],
        backendKind: "polling"
      })
    );
  });

  it("skips markdown content reads on unchanged polling ticks", async () => {
    vi.useRealTimers();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("recursive watch unsupported");
    });

    await registerAndWatch(webContents, workspace);
    fsPromisesMock.reset();

    await wait(1600);
    await wait(1600);

    const markdownContentReads = fsPromisesMock.state.readFilePaths.filter((path) =>
      path.endsWith(".md")
    );
    expect(markdownContentReads).toHaveLength(0);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("high-frequency probe loop does not recursively readdir inventory each tick", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);
    await flushMicrotasks();

    // Baseline inventory may readdir; reset counters after startup settles.
    await advanceAndFlush(600);
    await flushMicrotasks();
    fsPromisesMock.state.readdirPaths = [];
    fsPromisesMock.state.readFilePaths = [];

    // Several high-frequency probe intervals (~1s). Probe only stats known paths — no recursive walk.
    await advanceAndFlush(4000);
    await flushMicrotasks();

    expect(fsPromisesMock.state.readdirPaths).toHaveLength(0);

    // Inventory interval at 10s performs recursive membership scan (readdir of nodes tree).
    await advanceAndFlush(6000);
    await flushMicrotasks();
    const inventoryReaddirs = fsPromisesMock.state.readdirPaths.length;
    expect(inventoryReaddirs).toBeGreaterThan(0);

    fsPromisesMock.state.readdirPaths = [];
    // More probe ticks between inventory windows must still avoid readdir.
    await advanceAndFlush(4000);
    await flushMicrotasks();
    expect(fsPromisesMock.state.readdirPaths).toHaveLength(0);

    // Content hash sweep is deferred (~25s kickoff); before that, md body reads stay zero on probe ticks.
    const markdownReadsBeforeHash = fsPromisesMock.state.readFilePaths.filter((p) =>
      p.endsWith(".md")
    );
    expect(markdownReadsBeforeHash).toHaveLength(0);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("reports added and deleted deep prompt files from polling snapshots", async () => {
    vi.useRealTimers();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("recursive watch unsupported");
    });

    await registerAndWatch(webContents, workspace);
    const newPrompt = join(workspace.packageDir, "nodes", "T-001", "blocks", "B-002.prompt.md");
    await writeFile(newPrompt, "new block prompt\n", "utf8");
    await waitForPollAndDebounce();

    expect(webContents.send).toHaveBeenLastCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: ["package/nodes/T-001/blocks/B-002.prompt.md"]
      })
    );

    webContents.send.mockClear();
    await unlink(newPrompt);
    await waitForPollAndDebounce();

    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: ["package/nodes/T-001/blocks/B-002.prompt.md"]
      })
    );
  });

  it("known manifest edit detected via high-frequency (1s) probe under polling", async () => {
    vi.useRealTimers();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("no native");
    });

    await registerAndWatch(webContents, workspace);

    await writeFile(
      join(workspace.packageDir, "manifest.json"),
      JSON.stringify({ version: "plan-package/v1", t: Date.now() }),
      "utf8"
    );
    await wait(1200);
    await wait(100);

    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: expect.arrayContaining(["package/manifest.json"]),
        backendKind: "polling"
      })
    );
  });

  it("deep prompt add/delete detected within inventory SLA (~10s) under polling", async () => {
    vi.useRealTimers();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("no native");
    });

    await registerAndWatch(webContents, workspace);
    webContents.send.mockClear();

    const deepNew = join(workspace.packageDir, "nodes", "T-002", "blocks", "B-DEEP.prompt.md");
    await mkdir(dirname(deepNew), { recursive: true });
    await writeFile(deepNew, "deep new\n", "utf8");

    await wait(1200);

    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: expect.arrayContaining(["package/nodes/T-002/blocks/B-DEEP.prompt.md"])
      })
    );

    webContents.send.mockClear();
    await rm(deepNew, { force: true });
    await wait(1200);

    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: expect.arrayContaining(["package/nodes/T-002/blocks/B-DEEP.prompt.md"])
      })
    );
  });

  it("same-size same-mtime content edit is detected by hash sweep after baseline is established", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const target = join(workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md");
    const pinned = new Date("2020-01-01T00:00:00.000Z");
    await utimes(target, pinned, pinned);

    await registerAndWatch(webContents, workspace);
    await advanceAndFlush(30_000);
    await flushDebounce();
    webContents.send.mockClear();

    const pinnedBefore = await stat(target);
    const original = await readFile(target);
    const replacement = Buffer.alloc(original.length, 0x42);
    expect(replacement.length).toBe(original.length);
    await writeFile(target, replacement);
    await utimes(target, pinned, pinned);
    const after = await stat(target);
    expect(after.size).toBe(pinnedBefore.size);
    expect(after.mtimeMs).toBe(pinnedBefore.mtimeMs);

    await advanceAndFlush(9000);
    await flushDebounce();
    expect(webContents.send).not.toHaveBeenCalled();

    await advanceAndFlush(21_000);
    await flushDebounce();

    const had = webContents.send.mock.calls.some(
      (call) =>
        call[0] === packageFileChangedChannel &&
        (call[1].paths || []).includes("package/nodes/T-001/blocks/B-001.prompt.md")
    );
    expect(had).toBe(true);
  });

  it("inventory refresh preserves hash baseline so same-mtime edits are not permanently missed", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const target = join(workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md");
    const pinned = new Date("2020-01-01T00:00:00.000Z");
    await utimes(target, pinned, pinned);

    await registerAndWatch(webContents, workspace);
    await advanceAndFlush(30_000);
    await flushDebounce();
    webContents.send.mockClear();

    await advanceAndFlush(10_000);
    await flushDebounce();
    webContents.send.mockClear();

    const original = await readFile(target);
    await writeFile(target, Buffer.alloc(original.length, 0x43));
    await utimes(target, pinned, pinned);
    const after = await stat(target);
    expect(after.mtimeMs).toBe(pinned.getTime());

    await advanceAndFlush(19_000);
    await flushDebounce();
    expect(webContents.send).not.toHaveBeenCalled();

    await advanceAndFlush(1000);
    await flushDebounce();

    const had = webContents.send.mock.calls.some(
      (call) =>
        call[0] === packageFileChangedChannel &&
        (call[1].paths || []).includes("package/nodes/T-001/blocks/B-001.prompt.md")
    );
    expect(had).toBe(true);
  });

  it("polling unwatch clears kickoff timers immediately (active timer count is zero)", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    await registerAndWatch(webContents, workspace);
    await flushMicrotasks();

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await unwatch(webContents, workspace);
    await flushMicrotasks();

    expect(vi.getTimerCount()).toBe(0);

    await writeFile(
      join(workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "after unwatch\n",
      "utf8"
    );
    await advanceAndFlush(30_000);
    await flushDebounce();
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("close drops in-flight probe mutations after delayed I/O resolves", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const deferredStat = createDeferred<void>();

    await registerAndWatch(webContents, workspace);
    await flushMicrotasks();
    webContents.send.mockClear();

    fsPromisesMock.state.holdStatPromise = deferredStat.promise;
    await advanceAndFlush(1000);
    await unwatch(webContents, workspace);

    deferredStat.resolve();
    fsPromisesMock.state.holdStatPromise = null;
    await flushMicrotasks();
    await advanceAndFlush(5000);
    await flushDebounce();

    expect(webContents.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hash sweep single-flight: one read failure does not overlap the next sweep generation", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const deferredReads: Array<ReturnType<typeof createDeferred<Buffer>>> = [];
    let rejectFirst = true;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await registerAndWatch(webContents, workspace);
      await flushMicrotasks();
      webContents.send.mockClear();
      fsPromisesMock.state.maxActiveReadFiles = 0;

      fsPromisesMock.state.readFileHook = async () => {
        if (rejectFirst) {
          rejectFirst = false;
          throw new Error("simulated hash read failure");
        }
        const deferred = createDeferred<Buffer>();
        deferredReads.push(deferred);
        return deferred.promise;
      };

      await advanceAndFlush(25_000);
      await flushMicrotasks();

      expect(fsPromisesMock.state.maxActiveReadFiles).toBeLessThanOrEqual(4);
      const held = deferredReads.length;
      expect(held).toBeGreaterThan(0);
      expect(fsPromisesMock.state.activeReadFiles).toBe(held);

      await advanceAndFlush(30_000);
      await flushMicrotasks();
      expect(fsPromisesMock.state.maxActiveReadFiles).toBeLessThanOrEqual(4);
      expect(fsPromisesMock.state.activeReadFiles).toBe(held);

      expect(webContents.send).not.toHaveBeenCalled();

      fsPromisesMock.state.readFileHook = null;
      for (const deferred of deferredReads) {
        deferred.resolve(Buffer.from("stale"));
      }
      await flushMicrotasks();
      await flushDebounce();
      expect(warnSpy).toHaveBeenCalled();
      expect(webContents.send).not.toHaveBeenCalled();
    } finally {
      fsPromisesMock.state.readFileHook = null;
      warnSpy.mockRestore();
    }
  });

  it("a stale hash sweep cannot resurrect a path removed by probe and inventory", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const target = join(workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md");
    const releaseHashRead = createDeferred<Buffer>();
    let targetReadStarted = false;

    try {
      await registerAndWatch(webContents, workspace);
      fsPromisesMock.state.readFileHook = (path) => {
        if (path === target) {
          targetReadStarted = true;
          return releaseHashRead.promise;
        }
      };

      await advanceAndFlush(25_000);
      expect(targetReadStarted).toBe(true);

      await unlink(target);
      await advanceAndFlush(5000);
      await flushDebounce();
      webContents.send.mockClear();

      fsPromisesMock.state.readFileHook = null;
      releaseHashRead.resolve(Buffer.from("block prompt\n"));
      await flushMicrotasks();

      await advanceAndFlush(10_000);
      await flushDebounce();
      expect(webContents.send).not.toHaveBeenCalled();
    } finally {
      fsPromisesMock.state.readFileHook = null;
      releaseHashRead.resolve(Buffer.from("block prompt\n"));
    }
  });

  it("a stale hash sweep cannot overwrite a fingerprint just published by probe", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const target = join(workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md");
    const releaseHashRead = createDeferred<Buffer>();
    const hashReadStarted = createDeferred<void>();
    const releaseProbeStat = createDeferred<void>();
    const probeStatStarted = createDeferred<void>();
    const probeTailCompleted = createDeferred<void>();
    let probeReleased = false;
    let probeTailCallId: number | null = null;

    try {
      await registerAndWatch(webContents, workspace);
      fsPromisesMock.state.readFileHook = (path) => {
        if (path === target) {
          hashReadStarted.resolve();
          return releaseHashRead.promise;
        }
      };

      await advanceAndFlush(25_000);
      await hashReadStarted.promise;

      fsPromisesMock.state.statHook = async (path, callId) => {
        if (path === target && !probeReleased) {
          probeStatStarted.resolve();
          await releaseProbeStat.promise;
          return;
        }
        if (path === workspace.projectPromptFile && probeReleased && probeTailCallId === null) {
          probeTailCallId = callId;
        }
      };
      fsPromisesMock.state.statResultHook = (_path, callId) => {
        if (callId === probeTailCallId) {
          probeTailCompleted.resolve();
        }
      };

      await advanceAndFlush(1000);
      await probeStatStarted.promise;

      await writeFile(target, "changed while hash read is in flight\n", "utf8");
      probeReleased = true;
      releaseProbeStat.resolve();
      await probeTailCompleted.promise;
      await flushMicrotasks();
      await flushDebounce();
      expect(webContents.send).toHaveBeenCalledWith(
        packageFileChangedChannel,
        expect.objectContaining({
          paths: expect.arrayContaining(["package/nodes/T-001/blocks/B-001.prompt.md"])
        })
      );
      webContents.send.mockClear();

      fsPromisesMock.state.readFileHook = null;
      releaseHashRead.resolve(Buffer.from("block prompt\n"));
      await flushMicrotasks();
      await flushDebounce();
      webContents.send.mockClear();

      await advanceAndFlush(1000);
      await flushDebounce();
      expect(webContents.send).not.toHaveBeenCalled();
    } finally {
      fsPromisesMock.state.statHook = null;
      fsPromisesMock.state.statResultHook = null;
      fsPromisesMock.state.readFileHook = null;
      releaseProbeStat.resolve();
      releaseHashRead.resolve(Buffer.from("block prompt\n"));
    }
  });

  it("polling failures use deterministic bounded backoff and do not publish synthetic changes", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await registerAndWatch(webContents, workspace);
      await advanceAndFlush(1200);
      await flushDebounce();
      webContents.send.mockClear();
      warnSpy.mockClear();

      fsPromisesMock.state.failStat = true;

      await advanceAndFlush(1000);
      await flushMicrotasks();
      expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
      expect(webContents.send).not.toHaveBeenCalled();
      const warningsAfterFirstFailure = warnSpy.mock.calls.length;

      await advanceAndFlush(500);
      await flushMicrotasks();
      expect(warnSpy.mock.calls.length).toBe(warningsAfterFirstFailure);
      expect(webContents.send).not.toHaveBeenCalled();

      await advanceAndFlush(1000);
      await flushMicrotasks();
      expect(warnSpy.mock.calls.length).toBeGreaterThan(warningsAfterFirstFailure);
      expect(webContents.send).not.toHaveBeenCalled();

      for (let i = 0; i < 6; i += 1) {
        await advanceAndFlush(16_000);
        await flushMicrotasks();
      }
      expect(webContents.send).not.toHaveBeenCalled();

      fsPromisesMock.state.failStat = false;
      await advanceAndFlush(16_000);
      await flushMicrotasks();
      webContents.send.mockClear();
      warnSpy.mockClear();

      await writeFile(
        join(workspace.packageDir, "manifest.json"),
        JSON.stringify({ version: "plan-package/v1", recovered: true }),
        "utf8"
      );
      await advanceAndFlush(1000);
      await flushDebounce();

      expect(webContents.send).toHaveBeenCalledWith(
        packageFileChangedChannel,
        expect.objectContaining({
          paths: expect.arrayContaining(["package/manifest.json"]),
          backendKind: "polling"
        })
      );
    } finally {
      fsPromisesMock.state.failStat = false;
      warnSpy.mockRestore();
    }
  });

  it("inventory cannot consume a known-file edit before a concurrent probe publishes it", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const releaseProbeStat = createDeferred<void>();
    const probeStatStarted = createDeferred<void>();
    const inventoryCompleted = createDeferred<void>();
    const probeTailCompleted = createDeferred<void>();
    let probeReleased = false;
    let manifestStatCalls = 0;
    let probeTailCallId: number | null = null;

    try {
      await registerAndWatch(webContents, workspace);
      await advanceAndFlush(1200);
      await flushDebounce();
      webContents.send.mockClear();

      fsPromisesMock.state.statHook = async (path, callId) => {
        if (path === workspace.manifestFile) {
          manifestStatCalls += 1;
          if (manifestStatCalls === 1) {
            probeStatStarted.resolve();
            await releaseProbeStat.promise;
          }
        }
        if (path === workspace.projectPromptFile && probeReleased && probeTailCallId === null) {
          probeTailCallId = callId;
        }
      };
      fsPromisesMock.state.statResultHook = (path, callId) => {
        if (path === workspace.projectPromptFile && !probeReleased) {
          inventoryCompleted.resolve();
        }
        if (callId === probeTailCallId) {
          probeTailCompleted.resolve();
        }
      };

      await writeFile(
        workspace.manifestFile,
        JSON.stringify({ version: "plan-package/v1", inventoryRace: true }),
        "utf8"
      );

      await advanceAndFlush(800);
      await probeStatStarted.promise;
      await advanceAndFlush(8000);
      await inventoryCompleted.promise;
      await flushMicrotasks();
      expect(manifestStatCalls).toBeGreaterThanOrEqual(2);
      expect(webContents.send).not.toHaveBeenCalled();

      probeReleased = true;
      releaseProbeStat.resolve();
      await probeTailCompleted.promise;
      await flushMicrotasks();
      await flushDebounce();

      expect(webContents.send).toHaveBeenCalledWith(
        packageFileChangedChannel,
        expect.objectContaining({
          paths: expect.arrayContaining(["package/manifest.json"]),
          backendKind: "polling"
        })
      );
    } finally {
      fsPromisesMock.state.statHook = null;
      fsPromisesMock.state.statResultHook = null;
      releaseProbeStat.resolve();
    }
  });
});
