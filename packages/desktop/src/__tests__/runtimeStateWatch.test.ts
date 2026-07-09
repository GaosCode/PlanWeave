import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopBridgeInvokeChannels, runtimeStateChangedChannel } from "../shared/ipcChannels";

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

vi.mock("@planweave-ai/runtime", () => ({
  resolveTaskCanvasWorkspace: runtimeMock.resolveTaskCanvasWorkspace
}));

const tempRoots: string[] = [];

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
  const { registerRuntimeStateWatchHandlers } = await import("../main/runtimeStateWatch");
  registerRuntimeStateWatchHandlers();
  const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.watchRuntimeState);
  expect(handler).toBeDefined();
  await handler?.(
    { sender: webContents },
    { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
  );
}

async function unwatch(webContents: TestWebContents, workspace: TestWorkspace): Promise<void> {
  const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.unwatchRuntimeState);
  expect(handler).toBeDefined();
  await handler?.(
    { sender: webContents },
    { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
  );
}

async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(150);
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
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

describe("runtime state watcher", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
    fsMock.watchers.length = 0;
    fsMock.watch.mockClear();
    runtimeMock.state.workspace = null;
    runtimeMock.resolveTaskCanvasWorkspace.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      tempRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true }))
    );
  });

  it("notifies subscribers when the current canvas state file changes", async () => {
    vi.useRealTimers();
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
    await wait(250);

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

  it("polling fallback detects same-size state file edits", async () => {
    vi.useRealTimers();
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("native watch unsupported");
    });

    await registerAndWatch(webContents, workspace);
    const before = await stat(workspace.stateFile);
    await writeFile(workspace.stateFile, JSON.stringify({ version: 2, tasks: {} }), "utf8");
    await utimes(workspace.stateFile, before.atime, before.mtime);
    await waitForPollAndDebounce();

    expect(webContents.send).toHaveBeenCalledWith(
      runtimeStateChangedChannel,
      expect.objectContaining({
        projectRoot: workspace.rootPath,
        canvasId: "canvas-a",
        stateFile: workspace.stateFile
      })
    );
  });
});
