import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopBridgeInvokeChannels } from "../shared/ipcChannels";

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;

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

const runtimeMock = vi.hoisted(() => ({
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
  }))
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
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
    getGraphViewModel: runtimeMock.getGraphViewModel,
    resolveProjectCanvasWorkspace: runtimeMock.resolveProjectCanvasWorkspace,
    resolveTaskCanvasWorkspace: runtimeMock.resolveTaskCanvasWorkspace
  };
});

describe("runtime bridge handlers", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
    runtimeMock.getGraphViewModel.mockClear();
    runtimeMock.resolveProjectCanvasWorkspace.mockClear();
    runtimeMock.resolveTaskCanvasWorkspace.mockClear();
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

  it("registers handlers for every desktop bridge invoke channel", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    const { registerPackageWatchHandlers } = await import("../main/packageWatch");

    registerRuntimeBridgeHandlers();
    registerPackageWatchHandlers();

    expect(new Set(electronMock.handlers.keys())).toEqual(new Set(Object.values(desktopBridgeInvokeChannels)));
    expect(electronMock.handlers.has(desktopBridgeInvokeChannels.watchPackageFiles)).toBe(true);
    expect(electronMock.handlers.has(desktopBridgeInvokeChannels.unwatchPackageFiles)).toBe(true);
  });
});
