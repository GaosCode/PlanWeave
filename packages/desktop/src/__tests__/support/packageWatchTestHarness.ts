import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { desktopBridgeInvokeChannels } from "../../shared/ipcChannels";

export type RegisteredHandler = (
  event: { sender: TestWebContents },
  ref: { projectRoot: string; canvasId?: string | null }
) => unknown;

export type WatchCallback = (eventType: string, filename: string | Buffer | null) => void;

export type TestWebContents = {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};

export type TestWorkspace = {
  rootPath: string;
  workspaceRoot: string;
  packageDir: string;
  manifestFile: string;
  projectPromptFile: string;
};

export type FakeFsWatcher = {
  rootPath: string;
  options: { recursive?: boolean };
  callback: WatchCallback;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  errorHandlers: Array<(e: unknown) => void>;
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
  const watchers: FakeFsWatcher[] = [];
  return {
    watchers,
    watch: vi.fn((rootPath: string, options: { recursive?: boolean }, callback: WatchCallback) =>
      createFakeWatcher(watchers, rootPath, options, callback)
    )
  };
});

const fsPromisesMock = vi.hoisted(() => {
  const state = {
    readFilePaths: [] as string[],
    readdirPaths: [] as string[],
    failStat: false,
    holdStatPromise: null as Promise<unknown> | null,
    statHook: null as null | ((path: string) => Promise<void> | void),
    failReadFile: false,
    holdReadFilePromise: null as Promise<Buffer> | null,
    activeReadFiles: 0,
    maxActiveReadFiles: 0,
    readFileHook: null as null | ((path: string) => Promise<Buffer> | Buffer | void)
  };
  return {
    state,
    reset() {
      state.readFilePaths = [];
      state.readdirPaths = [];
      state.failStat = false;
      state.holdStatPromise = null;
      state.statHook = null;
      state.failReadFile = false;
      state.holdReadFilePromise = null;
      state.activeReadFiles = 0;
      state.maxActiveReadFiles = 0;
      state.readFileHook = null;
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

const tempRoots: string[] = [];

function createFakeWatcher(
  watchers: FakeFsWatcher[],
  rootPath: string,
  options: { recursive?: boolean },
  callback: WatchCallback
): FakeFsWatcher {
  const errorHandlers: Array<(e: unknown) => void> = [];
  const watcher: FakeFsWatcher = {
    rootPath,
    options,
    callback,
    close: vi.fn(),
    on: vi.fn((event: string, handler: (e: unknown) => void) => {
      if (event === "error") {
        errorHandlers.push(handler);
      }
      return watcher;
    }),
    removeAllListeners: vi.fn((event?: string) => {
      if (!event || event === "error") {
        errorHandlers.length = 0;
      }
      return watcher;
    }),
    errorHandlers
  };
  watchers.push(watcher);
  return watcher;
}

export function getPackageWatchMocks() {
  return { electronMock, fsMock, fsPromisesMock, runtimeMock };
}

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
    readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
      const target = args[0];
      const pathText =
        typeof target === "string"
          ? target
          : Buffer.isBuffer(target)
            ? target.toString("utf8")
            : String(target);
      fsPromisesMock.state.readdirPaths.push(pathText);
      return actual.readdir(...args);
    }),
    stat: vi.fn(async (...args: Parameters<typeof actual.stat>) => {
      const target = args[0];
      const pathText =
        typeof target === "string"
          ? target
          : Buffer.isBuffer(target)
            ? target.toString("utf8")
            : String(target);
      if (fsPromisesMock.state.failStat) {
        throw new Error("simulated probe failure");
      }
      if (fsPromisesMock.state.holdStatPromise) {
        await fsPromisesMock.state.holdStatPromise;
      }
      await fsPromisesMock.state.statHook?.(pathText);
      return actual.stat(...args);
    }),
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      const target = args[0];
      const pathText =
        typeof target === "string"
          ? target
          : Buffer.isBuffer(target)
            ? target.toString("utf8")
            : String(target);
      fsPromisesMock.state.readFilePaths.push(pathText);

      fsPromisesMock.state.activeReadFiles += 1;
      fsPromisesMock.state.maxActiveReadFiles = Math.max(
        fsPromisesMock.state.maxActiveReadFiles,
        fsPromisesMock.state.activeReadFiles
      );
      try {
        if (fsPromisesMock.state.readFileHook) {
          const hooked = await fsPromisesMock.state.readFileHook(pathText);
          if (hooked !== undefined) {
            return hooked as never;
          }
        }
        if (fsPromisesMock.state.failReadFile) {
          throw new Error("simulated hash read failure");
        }
        if (fsPromisesMock.state.holdReadFilePromise) {
          return (await fsPromisesMock.state.holdReadFilePromise) as never;
        }
        return actual.readFile(...args);
      } finally {
        fsPromisesMock.state.activeReadFiles -= 1;
      }
    })
  };
});

vi.mock("@planweave-ai/runtime", () => ({
  resolveTaskCanvasWorkspace: runtimeMock.resolveTaskCanvasWorkspace
}));

export async function createWorkspace(): Promise<TestWorkspace> {
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

export function createWebContents(id = 1): TestWebContents {
  return {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn()
  };
}

export function createDeferred<T>(): {
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

export async function registerAndWatch(
  webContents: TestWebContents,
  workspace: TestWorkspace
): Promise<void> {
  runtimeMock.state.workspace = workspace;
  const { registerPackageWatchHandlers } = await import("../../main/packageWatch");
  registerPackageWatchHandlers();
  const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.watchPackageFiles);
  expect(handler).toBeDefined();
  await handler?.(
    { sender: webContents },
    { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
  );
}

export async function unwatch(
  webContents: TestWebContents,
  workspace: TestWorkspace
): Promise<void> {
  const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.unwatchPackageFiles);
  expect(handler).toBeDefined();
  await handler?.(
    { sender: webContents },
    { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
  );
}

export async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(150);
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForPollAndDebounce(): Promise<void> {
  await wait(1600);
  await wait(250);
}

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
  for (let i = 0; i < 16; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export async function advanceAndFlush(ms: number): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(remaining, 250);
    await vi.advanceTimersByTimeAsync(step);
    await flushMicrotasks();
    remaining -= step;
  }
}

export function forcePollingBackend(): void {
  fsMock.watch.mockImplementation(() => {
    throw new Error("recursive watch unsupported");
  });
}

export function resetFakeWatchImplementation(): void {
  fsMock.watch.mockReset();
  fsMock.watch.mockImplementation(
    (rootPath: string, options: { recursive?: boolean }, callback: WatchCallback) =>
      createFakeWatcher(fsMock.watchers, rootPath, options, callback)
  );
}

export function resetPackageWatchTestState(): void {
  electronMock.handlers.clear();
  electronMock.ipcMain.handle.mockClear();
  fsMock.watchers.length = 0;
  fsMock.watch.mockClear();
  resetFakeWatchImplementation();
  fsPromisesMock.reset();
  runtimeMock.state.workspace = null;
  runtimeMock.resolveTaskCanvasWorkspace.mockClear();
}

export async function cleanupPackageWatchTempRoots(): Promise<void> {
  await Promise.all(
    tempRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true }))
  );
}

/** Fire error handlers for every native watcher without relying on removeAllListeners side effects. */
export function emitNativeWatcherErrors(watchers: FakeFsWatcher[], error: Error): void {
  for (const watcher of watchers) {
    const handlers = [...watcher.errorHandlers];
    for (const handler of handlers) {
      handler(error);
    }
  }
}
