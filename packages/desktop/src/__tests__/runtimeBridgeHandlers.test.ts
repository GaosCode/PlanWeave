import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoRunChangedChannel, desktopBridgeInvokeChannels } from "../shared/ipcChannels";

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;
type AutoRunEventListener = (event: unknown) => void;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, RegisteredHandler>();
  const windows: Array<{ webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } }> = [];
  return {
    handlers,
    windows,
    ipcMain: {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      })
    },
    BrowserWindow: {
      fromWebContents: vi.fn(),
      getAllWindows: vi.fn(() => windows)
    }
  };
});

const runtimeMock = vi.hoisted(() => {
  const autoRunEventListeners = new Set<AutoRunEventListener>();
  return {
    autoRunEventListeners,
    getDesktopProjectSnapshot: vi.fn(async (ref: unknown) => ({ ref })),
    getGraphViewModel: vi.fn(async (workspace: unknown) => ({ workspace })),
    resolveProjectCanvasWorkspace: vi.fn(async (projectRoot: string, canvasId: string) => ({
      projectRoot,
      canvasId,
      source: "project"
    })),
    resolveTaskCanvasWorkspace: vi.fn(async (projectRoot: string, canvasId?: string | null) => ({
      projectRoot,
      canvasId,
      source: "task"
    })),
    subscribeAutoRunEvents: vi.fn((listener: AutoRunEventListener) => {
      autoRunEventListeners.add(listener);
      return () => autoRunEventListeners.delete(listener);
    })
  };
});

vi.mock("electron", () => ({
  BrowserWindow: electronMock.BrowserWindow,
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: electronMock.ipcMain,
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn()
  }
}));

vi.mock("@planweave-ai/runtime", async () => {
  const actual = await vi.importActual<typeof import("@planweave-ai/runtime")>("@planweave-ai/runtime");
  return {
    ...actual,
    getDesktopProjectSnapshot: runtimeMock.getDesktopProjectSnapshot,
    getGraphViewModel: runtimeMock.getGraphViewModel,
    resolveProjectCanvasWorkspace: runtimeMock.resolveProjectCanvasWorkspace,
    resolveTaskCanvasWorkspace: runtimeMock.resolveTaskCanvasWorkspace,
    subscribeAutoRunEvents: runtimeMock.subscribeAutoRunEvents
  };
});

describe("runtime bridge handlers", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.windows.length = 0;
    electronMock.ipcMain.handle.mockClear();
    electronMock.BrowserWindow.fromWebContents.mockClear();
    electronMock.BrowserWindow.getAllWindows.mockClear();
    runtimeMock.autoRunEventListeners.clear();
    runtimeMock.getDesktopProjectSnapshot.mockClear();
    runtimeMock.getGraphViewModel.mockClear();
    runtimeMock.resolveProjectCanvasWorkspace.mockClear();
    runtimeMock.resolveTaskCanvasWorkspace.mockClear();
    runtimeMock.subscribeAutoRunEvents.mockClear();
  });

  it("resolves desktop canvas references through runtime task canvas workspace API", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.getGraphViewModel);
    expect(handler).toBeDefined();

    await handler?.(null, { projectRoot: "/tmp/project", canvasId: "canvas-a" });

    expect(runtimeMock.resolveTaskCanvasWorkspace).toHaveBeenCalledWith("/tmp/project", "canvas-a");
    expect(runtimeMock.resolveProjectCanvasWorkspace).not.toHaveBeenCalled();
    expect(runtimeMock.getGraphViewModel).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      source: "task"
    });
  });

  it("passes desktop project snapshot requests to runtime without pre-resolving the canvas", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.getDesktopProjectSnapshot);
    expect(handler).toBeDefined();

    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
    await handler?.(null, ref);

    expect(runtimeMock.resolveTaskCanvasWorkspace).not.toHaveBeenCalled();
    expect(runtimeMock.getDesktopProjectSnapshot).toHaveBeenCalledWith(ref);
  });

  it("registers handlers for every desktop bridge invoke channel", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    const { registerPackageWatchHandlers } = await import("../main/packageWatch");

    registerRuntimeBridgeHandlers();
    registerPackageWatchHandlers();

    expect(new Set(electronMock.handlers.keys())).toEqual(new Set(Object.values(desktopBridgeInvokeChannels)));
    expect(electronMock.handlers.has(desktopBridgeInvokeChannels.watchPackageFiles)).toBe(true);
    expect(electronMock.handlers.has(desktopBridgeInvokeChannels.unwatchPackageFiles)).toBe(true);
  });

  it("broadcasts auto-run runtime events to every active window once", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    const activeSend = vi.fn();
    const destroyedSend = vi.fn();
    electronMock.windows.push(
      { webContents: { isDestroyed: () => false, send: activeSend } },
      { webContents: { isDestroyed: () => true, send: destroyedSend } }
    );

    registerRuntimeBridgeHandlers();
    registerRuntimeBridgeHandlers();

    expect(runtimeMock.subscribeAutoRunEvents).toHaveBeenCalledTimes(1);
    const event = {
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      runId: "RUN-001",
      phase: "running",
      eventType: "step_started"
    };
    for (const listener of runtimeMock.autoRunEventListeners) {
      listener(event);
    }

    expect(activeSend).toHaveBeenCalledWith(autoRunChangedChannel, event);
    expect(destroyedSend).not.toHaveBeenCalled();
  });
});
