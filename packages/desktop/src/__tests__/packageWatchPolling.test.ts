import { mkdir, readFile, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packageFileChangedChannel } from "../shared/ipcChannels";
import {
  advanceWatchTime,
  advanceWatchTimeAndSettle,
  cleanupPackageWatchTestResources,
  createDeferred,
  createWebContents,
  createWorkspace,
  flushDebounce,
  settleWatchTasks,
  forcePollingBackend,
  getPackageWatchMocks,
  getWatchRuntimeTestDriver,
  registerAndWatch,
  resetPackageWatchTestState,
  replaceFixtureTaskPrompt,
  unwatch,
  waitForPollAndDebounce
} from "./support/packageWatchTestHarness";

const { fsMock, fsPromisesMock } = getPackageWatchMocks();

describe("package file watcher: polling SLA and resources", () => {
  beforeEach(() => {
    vi.resetModules();
    resetPackageWatchTestState();
  });

  afterEach(async () => {
    await cleanupPackageWatchTestResources();
  });

  it("detects size-changing prompt edits from polling snapshots without content hashing", async () => {
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

  it("updates shared membership from manifest and hashes a shared physical target once per sweep", async ({
    skip
  }) => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const first = "shared/task.md";
    const second = "shared/block.md";
    const target = join(workspace.packageDir, "shared/source.txt");
    await mkdir(dirname(target));
    await writeFile(target, "shared prompt");
    try {
      await symlink(target, join(workspace.packageDir, first), "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        skip("The Windows test process lacks permission to create file symlinks.");
      }
      throw error;
    }
    await symlink(target, join(workspace.packageDir, second), "file");
    await registerAndWatch(webContents, workspace);
    await replaceFixtureTaskPrompt(workspace, first, second);
    await waitForPollAndDebounce();
    webContents.send.mockClear();

    await writeFile(target, "updated shared prompt");
    await waitForPollAndDebounce();
    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        backendKind: "polling",
        paths: [`package/${second}`, `package/${first}`]
      })
    );

    fsPromisesMock.state.readFilePaths = [];
    await advanceWatchTimeAndSettle(25_000);
    expect(fsPromisesMock.state.readFilePaths.filter((path) => path === target)).toHaveLength(1);
    expect(fsPromisesMock.state.readFilePaths).not.toContain(join(workspace.packageDir, first));

    await replaceFixtureTaskPrompt(
      workspace,
      "nodes/T-001/prompt.md",
      "nodes/T-001/blocks/B-001.prompt.md"
    );
    await waitForPollAndDebounce();
    webContents.send.mockClear();
    await writeFile(target, "shared prompt no longer referenced");
    await waitForPollAndDebounce();
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("skips markdown content reads on unchanged polling ticks", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("recursive watch unsupported");
    });

    await registerAndWatch(webContents, workspace);
    fsPromisesMock.reset();

    await advanceWatchTimeAndSettle(1600);
    await advanceWatchTimeAndSettle(1600);

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
    const blocksDirectory = join(workspace.packageDir, "nodes", "T-001", "blocks");

    const advanceUntilInventoryReaddirCompletes = async (ms: number): Promise<void> => {
      const completed = createDeferred<void>();
      fsPromisesMock.state.readdirResultHook = (path) => {
        if (path === blocksDirectory) {
          completed.resolve();
        }
      };
      await advanceWatchTimeAndSettle(ms);
      await completed.promise;
      fsPromisesMock.state.readdirResultHook = null;
    };

    await registerAndWatch(webContents, workspace);
    await settleWatchTasks();

    // Wait for the inventory kickoff's final recursive readdir result. Fake timers cannot
    // prove that real filesystem I/O has settled, so use the mocked I/O boundary explicitly.
    await advanceUntilInventoryReaddirCompletes(600);
    expect(fsPromisesMock.state.readdirPaths.length).toBeGreaterThan(0);
    fsPromisesMock.state.readdirPaths = [];
    fsPromisesMock.state.readFilePaths = [];

    // Several high-frequency probe intervals (~1s). Probe only stats known paths — no recursive walk.
    // Stay well under the 10s inventory interval so this window is probe-only.
    await advanceWatchTimeAndSettle(4000);
    await settleWatchTasks();
    expect(fsPromisesMock.state.readdirPaths).toHaveLength(0);

    // Inventory interval at 10s performs recursive membership scan (readdir of nodes tree).
    await advanceUntilInventoryReaddirCompletes(6000);
    const inventoryReaddirs = fsPromisesMock.state.readdirPaths.length;
    expect(inventoryReaddirs).toBeGreaterThan(0);

    fsPromisesMock.state.readdirPaths = [];
    // More probe ticks between inventory windows must still avoid readdir.
    await advanceWatchTimeAndSettle(4000);
    await settleWatchTasks();
    expect(fsPromisesMock.state.readdirPaths).toHaveLength(0);

    // Content hash sweep is deferred (~25s kickoff); before that, md body reads stay zero on probe ticks.
    const markdownReadsBeforeHash = fsPromisesMock.state.readFilePaths.filter((p) =>
      p.endsWith(".md")
    );
    expect(markdownReadsBeforeHash).toHaveLength(0);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("reports added and deleted deep prompt files from polling snapshots", async () => {
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
    await advanceWatchTimeAndSettle(1200);
    await advanceWatchTimeAndSettle(100);

    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: expect.arrayContaining(["package/manifest.json"]),
        backendKind: "polling"
      })
    );
  });

  it("deep prompt add/delete detected within inventory SLA (~10s) under polling", async () => {
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

    await advanceWatchTimeAndSettle(1200);

    expect(webContents.send).toHaveBeenCalledWith(
      packageFileChangedChannel,
      expect.objectContaining({
        paths: expect.arrayContaining(["package/nodes/T-002/blocks/B-DEEP.prompt.md"])
      })
    );

    webContents.send.mockClear();
    await rm(deepNew, { force: true });
    await advanceWatchTimeAndSettle(1200);

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
    await advanceWatchTimeAndSettle(30_000);
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

    await advanceWatchTimeAndSettle(9000);
    await flushDebounce();
    expect(webContents.send).not.toHaveBeenCalled();

    await advanceWatchTimeAndSettle(21_000);
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
    const hashSweepCompleted = createDeferred<void>();
    const expectedHashPaths = new Set([
      workspace.manifestFile,
      workspace.projectPromptFile,
      join(workspace.packageDir, "nodes", "T-001", "prompt.md"),
      target
    ]);
    const completedHashPaths = new Set<string>();
    const targetHashReadStarted = createDeferred<void>();
    const delayedTargetHashRead = createDeferred<Buffer>();
    const pinned = new Date("2020-01-01T00:00:00.000Z");
    await utimes(target, pinned, pinned);

    await registerAndWatch(webContents, workspace);
    await advanceWatchTimeAndSettle(30_000);
    await flushDebounce();
    webContents.send.mockClear();

    await advanceWatchTimeAndSettle(10_000);
    await flushDebounce();
    webContents.send.mockClear();

    const original = await readFile(target);
    const replacement = Buffer.alloc(original.length, 0x43);
    await writeFile(target, replacement);
    await utimes(target, pinned, pinned);
    const after = await stat(target);
    expect(after.mtimeMs).toBe(pinned.getTime());

    fsPromisesMock.state.readFileHook = (path) => {
      if (path === target) {
        targetHashReadStarted.resolve();
        return delayedTargetHashRead.promise;
      }
    };
    fsPromisesMock.state.readFileResultHook = (path) => {
      if (!expectedHashPaths.has(path)) {
        return;
      }
      completedHashPaths.add(path);
      if (completedHashPaths.size === expectedHashPaths.size) {
        hashSweepCompleted.resolve();
      }
    };

    try {
      await advanceWatchTimeAndSettle(19_000);
      await flushDebounce();
      expect(webContents.send).not.toHaveBeenCalled();

      advanceWatchTime(1000);
      await targetHashReadStarted.promise;
      expect(webContents.send).not.toHaveBeenCalled();

      delayedTargetHashRead.resolve(replacement);
      await hashSweepCompleted.promise;
      await settleWatchTasks();
      await flushDebounce();

      const had = webContents.send.mock.calls.some(
        (call) =>
          call[0] === packageFileChangedChannel &&
          (call[1].paths || []).includes("package/nodes/T-001/blocks/B-001.prompt.md")
      );
      expect(had).toBe(true);
    } finally {
      fsPromisesMock.state.readFileHook = null;
      fsPromisesMock.state.readFileResultHook = null;
      delayedTargetHashRead.resolve(replacement);
    }
  });

  it("polling unwatch clears kickoff timers immediately (active timer count is zero)", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    await registerAndWatch(webContents, workspace);
    await settleWatchTasks();

    expect(getWatchRuntimeTestDriver().pendingTimerCount()).toBeGreaterThan(0);
    await unwatch(webContents, workspace);
    await settleWatchTasks();

    expect(getWatchRuntimeTestDriver().pendingTimerCount()).toBe(0);

    await writeFile(
      join(workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "after unwatch\n",
      "utf8"
    );
    await advanceWatchTimeAndSettle(30_000);
    await flushDebounce();
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("close drops in-flight probe mutations after delayed I/O resolves", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const deferredStat = createDeferred<void>();

    await registerAndWatch(webContents, workspace);
    await settleWatchTasks();
    webContents.send.mockClear();

    fsPromisesMock.state.holdStatPromise = deferredStat.promise;
    advanceWatchTime(1000);
    await unwatch(webContents, workspace);

    deferredStat.resolve();
    fsPromisesMock.state.holdStatPromise = null;
    await settleWatchTasks();
    await advanceWatchTimeAndSettle(5000);
    await flushDebounce();

    expect(webContents.send).not.toHaveBeenCalled();
    expect(getWatchRuntimeTestDriver().pendingTimerCount()).toBe(0);
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
      await settleWatchTasks();
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

      advanceWatchTime(25_000);
      await vi.waitFor(() => expect(deferredReads.length).toBeGreaterThan(0));

      expect(fsPromisesMock.state.maxActiveReadFiles).toBeLessThanOrEqual(4);
      const held = deferredReads.length;
      expect(held).toBeGreaterThan(0);
      expect(fsPromisesMock.state.activeReadFiles).toBe(held);

      advanceWatchTime(30_000);
      expect(fsPromisesMock.state.maxActiveReadFiles).toBeLessThanOrEqual(4);
      expect(fsPromisesMock.state.activeReadFiles).toBe(held);

      expect(webContents.send).not.toHaveBeenCalled();

      fsPromisesMock.state.readFileHook = null;
      for (const deferred of deferredReads) {
        deferred.resolve(Buffer.from("stale"));
      }
      await settleWatchTasks();
      await flushDebounce();
      expect(warnSpy).toHaveBeenCalled();
      expect(webContents.send).not.toHaveBeenCalled();
    } finally {
      fsPromisesMock.state.readFileHook = null;
      warnSpy.mockRestore();
    }
  });

  it("serializes probe and inventory behind an in-flight hash sweep", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const target = join(workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md");
    const blocksDirectory = dirname(target);
    const releaseHashRead = createDeferred<Buffer>();
    const targetReadStarted = createDeferred<void>();
    let probeStarted = false;
    let inventoryStarted = false;

    try {
      await registerAndWatch(webContents, workspace);
      fsPromisesMock.state.readFileHook = (path) => {
        if (path === target) {
          targetReadStarted.resolve();
          return releaseHashRead.promise;
        }
      };

      advanceWatchTime(25_000);
      await targetReadStarted.promise;
      webContents.send.mockClear();

      await unlink(target);
      fsPromisesMock.state.statHook = (path) => {
        if (path === workspace.manifestFile) {
          probeStarted = true;
        }
      };
      fsPromisesMock.state.readdirResultHook = (path) => {
        if (path === blocksDirectory) {
          inventoryStarted = true;
        }
      };
      advanceWatchTime(5000);
      await Promise.resolve();

      expect(probeStarted).toBe(false);
      expect(inventoryStarted).toBe(false);
      expect(webContents.send).not.toHaveBeenCalled();

      fsPromisesMock.state.readFileHook = null;
      releaseHashRead.resolve(Buffer.from("block prompt\n"));
      await settleWatchTasks();
      expect(probeStarted).toBe(true);
      expect(inventoryStarted).toBe(true);
      await flushDebounce();

      expect(webContents.send).toHaveBeenCalledTimes(1);
      expect(webContents.send).toHaveBeenCalledWith(
        packageFileChangedChannel,
        expect.objectContaining({
          paths: expect.arrayContaining(["package/nodes/T-001/blocks/B-001.prompt.md"])
        })
      );
      webContents.send.mockClear();

      await advanceWatchTimeAndSettle(10_000);
      await flushDebounce();
      expect(webContents.send).not.toHaveBeenCalled();
    } finally {
      fsPromisesMock.state.readFileHook = null;
      fsPromisesMock.state.statHook = null;
      fsPromisesMock.state.readdirResultHook = null;
      releaseHashRead.resolve(Buffer.from("block prompt\n"));
    }
  });

  it("polling failures use deterministic bounded backoff and do not publish synthetic changes", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    let awaitedProbeWarning: ReturnType<typeof createDeferred<void>> | null = null;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((message) => {
      if (String(message).includes("[probe]")) {
        awaitedProbeWarning?.resolve();
      }
    });
    const advanceUntilProbeWarning = async (ms: number): Promise<void> => {
      awaitedProbeWarning = createDeferred<void>();
      await advanceWatchTimeAndSettle(ms);
      await awaitedProbeWarning.promise;
      awaitedProbeWarning = null;
      await settleWatchTasks();
    };

    try {
      await registerAndWatch(webContents, workspace);
      await advanceWatchTimeAndSettle(1200);
      await flushDebounce();
      webContents.send.mockClear();
      warnSpy.mockClear();

      fsPromisesMock.state.failStat = true;

      await advanceUntilProbeWarning(1000);
      const probeWarningCount = () =>
        warnSpy.mock.calls.filter(([message]) => String(message).includes("[probe]")).length;
      expect(probeWarningCount()).toBeGreaterThan(0);
      expect(webContents.send).not.toHaveBeenCalled();
      const probeWarningsAfterFirstFailure = probeWarningCount();

      await advanceWatchTimeAndSettle(500);
      await settleWatchTasks();
      expect(probeWarningCount()).toBe(probeWarningsAfterFirstFailure);
      expect(webContents.send).not.toHaveBeenCalled();

      await advanceUntilProbeWarning(1000);
      expect(probeWarningCount()).toBeGreaterThan(probeWarningsAfterFirstFailure);
      expect(webContents.send).not.toHaveBeenCalled();

      for (let i = 0; i < 6; i += 1) {
        await advanceWatchTimeAndSettle(16_000);
        await settleWatchTasks();
      }
      expect(webContents.send).not.toHaveBeenCalled();

      const recoveredProbeFinalStat = createDeferred<void>();
      let recoveredProjectPromptStatCount = 0;
      fsPromisesMock.state.statResultHook = (path) => {
        if (path !== workspace.projectPromptFile) {
          return;
        }
        recoveredProjectPromptStatCount += 1;
        if (recoveredProjectPromptStatCount === 2) {
          recoveredProbeFinalStat.resolve();
        }
      };
      fsPromisesMock.state.failStat = false;
      await advanceWatchTimeAndSettle(16_000);
      await recoveredProbeFinalStat.promise;
      await settleWatchTasks();
      fsPromisesMock.state.statResultHook = null;
      webContents.send.mockClear();
      warnSpy.mockClear();

      await writeFile(
        join(workspace.packageDir, "manifest.json"),
        JSON.stringify({ version: "plan-package/v1", recovered: true }),
        "utf8"
      );
      await advanceWatchTimeAndSettle(1000);
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
      fsPromisesMock.state.statResultHook = null;
      warnSpy.mockRestore();
    }
  });

  it("serializes inventory behind a slow probe and publishes the edit once", async () => {
    forcePollingBackend();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const releaseProbeStat = createDeferred<void>();
    const probeStatStarted = createDeferred<void>();
    const blocksDirectory = join(workspace.packageDir, "nodes", "T-001", "blocks");
    let inventoryStarted = false;

    try {
      await registerAndWatch(webContents, workspace);
      await advanceWatchTimeAndSettle(1200);
      await flushDebounce();
      webContents.send.mockClear();

      fsPromisesMock.state.statHook = async (path) => {
        if (path === workspace.manifestFile) {
          probeStatStarted.resolve();
          await releaseProbeStat.promise;
        }
      };
      fsPromisesMock.state.readdirResultHook = (path) => {
        if (path === blocksDirectory) {
          inventoryStarted = true;
        }
      };

      await writeFile(
        workspace.manifestFile,
        JSON.stringify({ version: "plan-package/v1", inventoryRace: true }),
        "utf8"
      );

      advanceWatchTime(800);
      await probeStatStarted.promise;
      advanceWatchTime(8000);
      await Promise.resolve();

      expect(inventoryStarted).toBe(false);
      expect(webContents.send).not.toHaveBeenCalled();

      releaseProbeStat.resolve();
      await settleWatchTasks();
      expect(inventoryStarted).toBe(true);
      await flushDebounce();

      expect(webContents.send).toHaveBeenCalledTimes(1);
      expect(webContents.send).toHaveBeenCalledWith(
        packageFileChangedChannel,
        expect.objectContaining({
          paths: expect.arrayContaining(["package/manifest.json"]),
          backendKind: "polling"
        })
      );
    } finally {
      fsPromisesMock.state.statHook = null;
      fsPromisesMock.state.readdirResultHook = null;
      releaseProbeStat.resolve();
    }
  });
});
