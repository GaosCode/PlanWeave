import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopBridgeInvokeChannels, packageFileChangedChannel } from "../shared/ipcChannels";

type RegisteredHandler = (
  event: { sender: TestWebContents },
  ref: { projectRoot: string; canvasId?: string | null }
) => unknown;
type WatchCallback = (eventType: string, filename: string | Buffer | null) => void;

type TestWebContents = {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};

type TestWorkspace = {
  rootPath: string;
  workspaceRoot: string;
  packageDir: string;
  manifestFile: string;
  projectPromptFile: string;
};

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, RegisteredHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      })
    }
  };
});

const fsMock = vi.hoisted(() => {
  const watchers: Array<{
    rootPath: string;
    options: { recursive?: boolean };
    callback: WatchCallback;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    watchers,
    watch: vi.fn((rootPath: string, options: { recursive?: boolean }, callback: WatchCallback) => {
      const watcher = {
        rootPath,
        options,
        callback,
        close: vi.fn()
      };
      watchers.push(watcher);
      return watcher;
    })
  };
});

const fsPromisesMock = vi.hoisted(() => {
  const state = {
    readFilePaths: [] as string[]
  };
  return {
    state,
    reset() {
      state.readFilePaths = [];
    }
  };
});

const runtimeMock = vi.hoisted(() => {
  const state = {
    workspace: null as TestWorkspace | null
  };
  return {
    state,
    resolveTaskCanvasWorkspace: vi.fn(async () => {
      if (!state.workspace) {
        throw new Error("Test workspace is not configured.");
      }
      return state.workspace;
    })
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: fsMock.watch
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      const target = args[0];
      if (typeof target === "string") {
        fsPromisesMock.state.readFilePaths.push(target);
      } else if (Buffer.isBuffer(target)) {
        fsPromisesMock.state.readFilePaths.push(target.toString("utf8"));
      } else {
        fsPromisesMock.state.readFilePaths.push(String(target));
      }
      return actual.readFile(...args);
    })
  };
});

vi.mock("@planweave-ai/runtime", () => {
  return {
    resolveTaskCanvasWorkspace: runtimeMock.resolveTaskCanvasWorkspace
  };
});

const tempRoots: string[] = [];

async function createWorkspace(): Promise<TestWorkspace> {
  const rootPath = await mkdtemp(join(tmpdir(), "planweave-package-watch-"));
  tempRoots.push(rootPath);
  const packageDir = join(rootPath, "package");
  const nodesDir = join(packageDir, "nodes", "T-001", "blocks");
  const projectPromptFile = join(rootPath, "policy", "project-prompt.md");
  await mkdir(nodesDir, { recursive: true });
  await mkdir(join(rootPath, "policy"), { recursive: true });
  await writeFile(
    join(packageDir, "manifest.json"),
    JSON.stringify({ version: "plan-package/v1" }),
    "utf8"
  );
  await writeFile(join(packageDir, "nodes", "T-001", "prompt.md"), "task prompt\n", "utf8");
  await writeFile(join(nodesDir, "B-001.prompt.md"), "block prompt\n", "utf8");
  await writeFile(projectPromptFile, "project prompt\n", "utf8");
  return {
    rootPath,
    workspaceRoot: rootPath,
    packageDir,
    manifestFile: join(packageDir, "manifest.json"),
    projectPromptFile
  };
}

function createWebContents(id = 1): TestWebContents {
  return {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn()
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return {
    promise,
    resolve: resolveDeferred,
    reject: rejectDeferred
  };
}

async function registerAndWatch(
  webContents: TestWebContents,
  workspace: TestWorkspace
): Promise<void> {
  runtimeMock.state.workspace = workspace;
  const { registerPackageWatchHandlers } = await import("../main/packageWatch");
  registerPackageWatchHandlers();
  const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.watchPackageFiles);
  expect(handler).toBeDefined();
  await handler?.(
    { sender: webContents },
    { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
  );
}

async function unwatch(webContents: TestWebContents, workspace: TestWorkspace): Promise<void> {
  const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.unwatchPackageFiles);
  expect(handler).toBeDefined();
  await handler?.(
    { sender: webContents },
    { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
  );
}

async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(150);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPollAndDebounce(): Promise<void> {
  await wait(1250);
  await wait(250);
}

describe("package file watcher", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
    fsMock.watchers.length = 0;
    fsMock.watch.mockClear();
    fsMock.watch.mockReset();
    fsMock.watch.mockImplementation(
      (rootPath: string, options: { recursive?: boolean }, callback: WatchCallback) => {
        const watcher = {
          rootPath,
          options,
          callback,
          close: vi.fn()
        };
        fsMock.watchers.push(watcher);
        return watcher;
      }
    );
    fsPromisesMock.reset();
    runtimeMock.state.workspace = null;
    runtimeMock.resolveTaskCanvasWorkspace.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      tempRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true }))
    );
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
    await writeFile(
      join(workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"),
      "changed block prompt\n",
      "utf8"
    );
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
    // Baseline snapshot may still touch other APIs; content reads for poll fingerprints must stay at zero.
    fsPromisesMock.reset();

    // Two full poll intervals over an unchanged package: mtime/size fingerprints must not read file bodies.
    await wait(1250);
    await wait(1250);

    const markdownContentReads = fsPromisesMock.state.readFilePaths.filter((path) =>
      path.endsWith(".md")
    );
    expect(markdownContentReads).toHaveLength(0);
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
    const deferredWorkspace = createDeferred<TestWorkspace>();
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
    const deferredWorkspace = createDeferred<TestWorkspace>();
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
    const deferredWorkspace = createDeferred<TestWorkspace>();
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
});
