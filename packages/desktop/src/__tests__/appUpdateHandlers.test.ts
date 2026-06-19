import { beforeEach, describe, expect, it, vi } from "vitest";
import { appUpdateChangedChannel, appUpdateInvokeChannels } from "../shared/appUpdate";

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;
type UpdaterListener = (...args: unknown[]) => void;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, RegisteredHandler>();
  const windows: Array<{ webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } }> = [];
  return {
    handlers,
    windows,
    app: {
      getVersion: vi.fn(() => "0.1.1"),
      isPackaged: false
    },
    BrowserWindow: {
      getAllWindows: vi.fn(() => windows)
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      })
    }
  };
});

const updaterMock = vi.hoisted(() => {
  const listeners = new Map<string, UpdaterListener[]>();
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    logger: null as unknown,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: UpdaterListener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    })
  };
  return {
    autoUpdater,
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    listeners
  };
});

vi.mock("electron", () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.BrowserWindow,
  ipcMain: electronMock.ipcMain
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: updaterMock.autoUpdater
  },
  autoUpdater: updaterMock.autoUpdater
}));

describe("app update handlers", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.windows.length = 0;
    electronMock.app.getVersion.mockClear();
    electronMock.app.isPackaged = false;
    electronMock.BrowserWindow.getAllWindows.mockClear();
    electronMock.ipcMain.handle.mockClear();
    updaterMock.listeners.clear();
    updaterMock.autoUpdater.checkForUpdates.mockReset();
    updaterMock.autoUpdater.downloadUpdate.mockReset();
    updaterMock.autoUpdater.quitAndInstall.mockReset();
    updaterMock.autoUpdater.on.mockClear();
  });

  it("registers app update handlers outside the runtime bridge", async () => {
    const { registerAppUpdateHandlers } = await import("../main/appUpdate");

    registerAppUpdateHandlers();

    expect(new Set(electronMock.handlers.keys())).toEqual(new Set(Object.values(appUpdateInvokeChannels)));
  });

  it("returns unsupported for update checks outside packaged builds", async () => {
    const { checkForAppUpdate, registerAppUpdateHandlers } = await import("../main/appUpdate");
    registerAppUpdateHandlers();

    const state = await checkForAppUpdate();

    expect(state.status).toBe("unsupported");
    expect(state.error).toContain("packaged");
    expect(updaterMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("publishes available updates to renderer windows", async () => {
    const send = vi.fn();
    electronMock.windows.push({ webContents: { isDestroyed: () => false, send } });
    const { registerAppUpdateHandlers } = await import("../main/appUpdate");
    registerAppUpdateHandlers();

    updaterMock.emit("update-available", {
      version: "0.1.2",
      releaseDate: "2026-06-19T00:00:00.000Z",
      releaseName: "PlanWeave 0.1.2"
    });

    expect(send).toHaveBeenCalledWith(appUpdateChangedChannel, expect.objectContaining({
      status: "available",
      update: expect.objectContaining({ version: "0.1.2" })
    }));
  });
});
