import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLANWEAVE_DESKTOP_RELEASES_URL,
  appUpdateChangedChannel,
  appUpdateInvokeChannels,
  resolveAppUpdateDelivery
} from "../shared/appUpdate";

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
    },
    shell: {
      openExternal: vi.fn().mockResolvedValue(undefined)
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
  ipcMain: electronMock.ipcMain,
  shell: electronMock.shell
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: updaterMock.autoUpdater
  },
  autoUpdater: updaterMock.autoUpdater
}));

describe("resolveAppUpdateDelivery", () => {
  it("uses github-releases on unsigned macOS and in-app elsewhere or when signed", () => {
    expect(resolveAppUpdateDelivery({ platform: "darwin", codeSigned: false })).toBe("github-releases");
    expect(resolveAppUpdateDelivery({ platform: "darwin", codeSigned: true })).toBe("in-app");
    expect(resolveAppUpdateDelivery({ platform: "win32", codeSigned: false })).toBe("in-app");
    expect(resolveAppUpdateDelivery({ platform: "linux", codeSigned: false })).toBe("in-app");
  });
});

describe("app update handlers", () => {
  const originalPlatform = process.platform;
  const originalCodeSigned = process.env.PLANWEAVE_DESKTOP_CODE_SIGNED;

  beforeEach(() => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.windows.length = 0;
    electronMock.app.getVersion.mockClear();
    electronMock.app.isPackaged = false;
    electronMock.BrowserWindow.getAllWindows.mockClear();
    electronMock.ipcMain.handle.mockClear();
    electronMock.shell.openExternal.mockClear();
    updaterMock.listeners.clear();
    updaterMock.autoUpdater.checkForUpdates.mockReset();
    updaterMock.autoUpdater.downloadUpdate.mockReset();
    updaterMock.autoUpdater.quitAndInstall.mockReset();
    updaterMock.autoUpdater.on.mockClear();
    delete process.env.PLANWEAVE_DESKTOP_CODE_SIGNED;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    if (originalCodeSigned === undefined) {
      delete process.env.PLANWEAVE_DESKTOP_CODE_SIGNED;
    } else {
      process.env.PLANWEAVE_DESKTOP_CODE_SIGNED = originalCodeSigned;
    }
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

  it("on unsigned macOS opens GitHub Releases instead of downloading or installing", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    electronMock.app.isPackaged = true;
    const send = vi.fn();
    electronMock.windows.push({ webContents: { isDestroyed: () => false, send } });

    const {
      downloadAppUpdate,
      installAppUpdate,
      registerAppUpdateHandlers
    } = await import("../main/appUpdate");
    registerAppUpdateHandlers();

    updaterMock.emit("update-available", {
      version: "0.1.2",
      releaseDate: "2026-06-19T00:00:00.000Z",
      releaseName: "PlanWeave 0.1.2"
    });

    const downloadState = await downloadAppUpdate();
    expect(downloadState.status).toBe("available");
    expect(downloadState.delivery).toBe("github-releases");
    expect(electronMock.shell.openExternal).toHaveBeenCalledWith(PLANWEAVE_DESKTOP_RELEASES_URL);
    expect(updaterMock.autoUpdater.downloadUpdate).not.toHaveBeenCalled();

    const installState = await installAppUpdate();
    expect(installState.status).toBe("error");
    expect(installState.error).toMatch(/unsigned macOS/i);
    expect(updaterMock.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("on signed or non-mac platforms keeps the in-app download/install path", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    electronMock.app.isPackaged = true;
    updaterMock.autoUpdater.downloadUpdate.mockResolvedValue(undefined);

    const {
      downloadAppUpdate,
      installAppUpdate,
      registerAppUpdateHandlers
    } = await import("../main/appUpdate");
    registerAppUpdateHandlers();

    updaterMock.emit("update-available", {
      version: "0.1.2",
      releaseDate: null,
      releaseName: null
    });

    const downloading = await downloadAppUpdate();
    expect(downloading.delivery).toBe("in-app");
    expect(updaterMock.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();

    updaterMock.emit("update-downloaded", {
      version: "0.1.2",
      releaseDate: null,
      releaseName: null
    });

    const installed = await installAppUpdate();
    expect(installed.status).toBe("downloaded");
    expect(updaterMock.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("treats macOS as in-app when PLANWEAVE_DESKTOP_CODE_SIGNED=1", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    process.env.PLANWEAVE_DESKTOP_CODE_SIGNED = "1";
    electronMock.app.isPackaged = true;
    updaterMock.autoUpdater.downloadUpdate.mockResolvedValue(undefined);

    const { downloadAppUpdate, registerAppUpdateHandlers } = await import("../main/appUpdate");
    registerAppUpdateHandlers();

    updaterMock.emit("update-available", {
      version: "0.1.3",
      releaseDate: null,
      releaseName: null
    });

    const state = await downloadAppUpdate();
    expect(state.delivery).toBe("in-app");
    expect(updaterMock.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
  });
});
