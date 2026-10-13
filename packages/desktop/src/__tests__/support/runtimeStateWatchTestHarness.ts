import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { desktopBridgeInvokeChannels } from "../../shared/ipcChannels";
import { WatchRuntimeTestDriver } from "./watchRuntimeTestDriver.js";

type RegisteredHandler = (
  event: { sender: TestWebContents },
  ref: {
    projectRoot: string;
    canvasId?: string | null;
    workspaceRoot: string;
    registrationId: string;
  }
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
  stateFile: string;
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
    nativeFailure(error: Error): void;
    emit: import("node:events").EventEmitter["emit"];
    on: import("node:events").EventEmitter["on"];
    once: import("node:events").EventEmitter["once"];
    removeListener: import("node:events").EventEmitter["removeListener"];
    listenerCount: import("node:events").EventEmitter["listenerCount"];
  }> = [];
  return {
    watchers,
    watch:
      vi.fn<
        (
          rootPath: string,
          options: { recursive?: boolean },
          callback: WatchCallback
        ) => (typeof watchers)[number]
      >()
  };
});

const fsPromisesMock = vi.hoisted(() => {
  const state = {
    activeReadFiles: 0,
    failStat: false,
    maxActiveReadFiles: 0,
    readFileCalls: 0,
    readFileCallHook: null as null | ((path: string) => void),
    readFileHook: null as null | ((path: string) => Buffer | Promise<Buffer> | undefined),
    readFileResultHook: null as null | ((path: string) => void),
    statResultHook: null as null | ((path: string) => void)
  };
  return {
    state,
    reset() {
      state.activeReadFiles = 0;
      state.failStat = false;
      state.maxActiveReadFiles = 0;
      state.readFileCalls = 0;
      state.readFileCallHook = null;
      state.readFileHook = null;
      state.readFileResultHook = null;
      state.statResultHook = null;
    }
  };
});

const runtimeMock = vi.hoisted(() => {
  const state = {
    workspace: null as TestWorkspace | null
  };
  return {
    state,
    resolveDesktopWatchWorkspace: vi.fn(async () => {
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
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  fsMock.watch.mockImplementation((rootPath, options, callback) => {
    const emitter = new EventEmitter();
    let closed = false;
    const watcher = Object.assign(emitter, {
      rootPath,
      options,
      callback,
      nativeFailure(error: Error) {
        // Node native errors release the handle without emitting close.
        closed = true;
        emitter.emit("error", error);
      },
      close: vi.fn(() => {
        if (closed) return;
        closed = true;
        process.nextTick(() => emitter.emit("close"));
      })
    });
    fsMock.watchers.push(watcher);
    return watcher;
  });
  return {
    ...actual,
    watch: fsMock.watch
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: async (path: Parameters<typeof actual.readFile>[0]) => {
      const normalizedPath = String(path);
      fsPromisesMock.state.readFileCalls += 1;
      fsPromisesMock.state.readFileCallHook?.(normalizedPath);
      fsPromisesMock.state.activeReadFiles += 1;
      fsPromisesMock.state.maxActiveReadFiles = Math.max(
        fsPromisesMock.state.maxActiveReadFiles,
        fsPromisesMock.state.activeReadFiles
      );
      try {
        const hooked = fsPromisesMock.state.readFileHook?.(normalizedPath);
        const result = hooked === undefined ? await actual.readFile(path) : await hooked;
        fsPromisesMock.state.readFileResultHook?.(normalizedPath);
        return result;
      } finally {
        fsPromisesMock.state.activeReadFiles -= 1;
      }
    },
    stat: async (path: Parameters<typeof actual.stat>[0]) => {
      const normalizedPath = String(path);
      if (fsPromisesMock.state.failStat) {
        throw new Error("simulated stat failure");
      }
      const result = await actual.stat(path);
      fsPromisesMock.state.statResultHook?.(normalizedPath);
      return result;
    }
  };
});

vi.mock("@planweave-ai/runtime", async () => {
  const actual =
    await vi.importActual<typeof import("@planweave-ai/runtime")>("@planweave-ai/runtime");
  return { ...actual, resolveDesktopWatchWorkspace: runtimeMock.resolveDesktopWatchWorkspace };
});

const tempRoots: string[] = [];
const activeWatches: Array<{
  webContents: TestWebContents;
  workspace: TestWorkspace;
}> = [];
const watchRuntimeDriver = new WatchRuntimeTestDriver();

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createWorkspace(): Promise<TestWorkspace> {
  const rootPath = await mkdtemp(join(tmpdir(), "planweave-runtime-state-watch-"));
  tempRoots.push(rootPath);
  const canvasRoot = join(rootPath, "canvases", "canvas-a");
  await mkdir(canvasRoot, { recursive: true });
  const stateFile = join(canvasRoot, "state.json");
  await writeFile(stateFile, JSON.stringify({ version: 1, tasks: {} }), "utf8");
  return {
    rootPath,
    workspaceRoot: canvasRoot,
    stateFile
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

async function registerAndWatch(
  webContents: TestWebContents,
  workspace: TestWorkspace
): Promise<void> {
  runtimeMock.state.workspace = workspace;
  const { registerRuntimeStateWatchHandlers } = await import("../../main/runtimeStateWatch");
  registerRuntimeStateWatchHandlers({ scheduler: watchRuntimeDriver });
  const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.watchRuntimeState);
  expect(handler).toBeDefined();
  await handler?.(
    { sender: webContents },
    {
      projectRoot: workspace.rootPath,
      canvasId: "canvas-a",
      workspaceRoot: workspace.rootPath,
      registrationId: `test-${webContents.id}`
    }
  );
  activeWatches.push({ webContents, workspace });
}

async function unwatch(webContents: TestWebContents, workspace: TestWorkspace): Promise<void> {
  const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.unwatchRuntimeState);
  expect(handler).toBeDefined();
  await handler?.(
    { sender: webContents },
    {
      projectRoot: workspace.rootPath,
      canvasId: "canvas-a",
      workspaceRoot: workspace.rootPath,
      registrationId: `test-${webContents.id}`
    }
  );
  const activeWatchIndex = activeWatches.findIndex(
    (activeWatch) => activeWatch.webContents === webContents && activeWatch.workspace === workspace
  );
  if (activeWatchIndex >= 0) {
    activeWatches.splice(activeWatchIndex, 1);
  }
}

async function flushDebounce(): Promise<void> {
  await watchRuntimeDriver.advanceByAndDrain(150);
}

async function advanceUntilStateStat(ms: number, stateFile: string): Promise<void> {
  const completed = createDeferred<void>();
  fsPromisesMock.state.statResultHook = (path) => {
    if (path === stateFile) {
      completed.resolve();
    }
  };
  watchRuntimeDriver.advanceBy(ms);
  await completed.promise;
  fsPromisesMock.state.statResultHook = null;
  await watchRuntimeDriver.drain();
}

async function advanceUntilFingerprint(ms: number, stateFile: string): Promise<void> {
  const completed = createDeferred<void>();
  let contentRead = false;
  fsPromisesMock.state.readFileResultHook = (path) => {
    if (path === stateFile) {
      contentRead = true;
    }
  };
  fsPromisesMock.state.statResultHook = (path) => {
    if (path === stateFile && contentRead) {
      completed.resolve();
    }
  };
  watchRuntimeDriver.advanceBy(ms);
  await completed.promise;
  fsPromisesMock.state.readFileResultHook = null;
  fsPromisesMock.state.statResultHook = null;
  await watchRuntimeDriver.drain();
}

async function advanceUntilReadFileCall(
  ms: number,
  stateFile: string,
  expectedCalls: number
): Promise<void> {
  const started = createDeferred<void>();
  fsPromisesMock.state.readFileCallHook = (path) => {
    if (path === stateFile && fsPromisesMock.state.readFileCalls >= expectedCalls) {
      started.resolve();
    }
  };
  watchRuntimeDriver.advanceBy(ms);
  await started.promise;
  fsPromisesMock.state.readFileCallHook = null;
  await watchRuntimeDriver.drain();
}

export {
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
};
