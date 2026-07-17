import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLANWEAVE_DESKTOP_RELEASES_URL,
  appUpdateChangedChannel,
  appUpdateInvokeChannels,
  resolveAppUpdateDelivery
} from "../shared/appUpdate";
import type { DesktopBuildMetadata } from "../shared/buildMetadata";

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;
type UpdaterListener = (...args: unknown[]) => void;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, RegisteredHandler>();
  const windows: Array<{
    webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
  }> = [];
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

const buildMetadataMock = vi.hoisted(() => ({
  loadDesktopBuildMetadata:
    vi.fn<(resourcesPath: string, expectedVersion: string) => DesktopBuildMetadata>()
}));

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

vi.mock("../main/buildMetadata", () => buildMetadataMock);

describe("resolveAppUpdateDelivery", () => {
  const signedRelease: DesktopBuildMetadata = {
    signedDistribution: true,
    channel: "release",
    version: "0.1.1"
  };

  it("requires verified signed release metadata for in-app delivery on macOS", () => {
    expect(resolveAppUpdateDelivery({ platform: "darwin", buildMetadata: null })).toBe(
      "github-releases"
    );
    expect(
      resolveAppUpdateDelivery({
        platform: "darwin",
        buildMetadata: {
          signedDistribution: false,
          channel: "development",
          version: "0.1.1"
        }
      })
    ).toBe("github-releases");
    expect(
      resolveAppUpdateDelivery({ platform: "darwin", buildMetadata: signedRelease })
    ).toBe("in-app");
    expect(resolveAppUpdateDelivery({ platform: "win32", buildMetadata: null })).toBe("in-app");
    expect(resolveAppUpdateDelivery({ platform: "linux", buildMetadata: null })).toBe("in-app");
  });
});

describe("app update handlers", () => {
  const originalPlatform = process.platform;
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
    buildMetadataMock.loadDesktopBuildMetadata.mockReset();
    buildMetadataMock.loadDesktopBuildMetadata.mockImplementation(() => {
      throw new Error("Desktop build metadata is missing.");
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("registers app update handlers outside the runtime bridge", async () => {
    const { registerAppUpdateHandlers } = await import("../main/appUpdate");

    registerAppUpdateHandlers();

    expect(new Set(electronMock.handlers.keys())).toEqual(
      new Set(Object.values(appUpdateInvokeChannels))
    );
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

    expect(send).toHaveBeenCalledWith(
      appUpdateChangedChannel,
      expect.objectContaining({
        status: "available",
        update: expect.objectContaining({ version: "0.1.2" })
      })
    );
  });

  it("on unverified macOS opens GitHub Releases instead of downloading or installing", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    electronMock.app.isPackaged = true;
    buildMetadataMock.loadDesktopBuildMetadata.mockReturnValue({
      signedDistribution: false,
      channel: "development",
      version: "0.1.1"
    });
    const send = vi.fn();
    electronMock.windows.push({ webContents: { isDestroyed: () => false, send } });

    const { downloadAppUpdate, installAppUpdate, registerAppUpdateHandlers } = await import(
      "../main/appUpdate"
    );
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
    expect(installState.error).toMatch(/verified signed macOS release/i);
    expect(updaterMock.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("on signed or non-mac platforms keeps the in-app download/install path", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    electronMock.app.isPackaged = true;
    buildMetadataMock.loadDesktopBuildMetadata.mockReturnValue({
      signedDistribution: true,
      channel: "release",
      version: "0.1.1"
    });
    updaterMock.autoUpdater.downloadUpdate.mockResolvedValue(undefined);

    const { downloadAppUpdate, installAppUpdate, registerAppUpdateHandlers } = await import(
      "../main/appUpdate"
    );
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

  it("treats macOS as in-app only when packaged metadata proves a signed release", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    electronMock.app.isPackaged = true;
    updaterMock.autoUpdater.downloadUpdate.mockResolvedValue(undefined);
    buildMetadataMock.loadDesktopBuildMetadata.mockReturnValue({
      signedDistribution: true,
      channel: "release",
      version: "0.1.1"
    });

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

  it("fails closed through the app-update bridge when packaged metadata is missing or corrupt", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    electronMock.app.isPackaged = true;
    buildMetadataMock.loadDesktopBuildMetadata.mockImplementation(() => {
      throw new Error("Desktop build metadata failed validation.");
    });

    const { downloadAppUpdate, getAppUpdateState, registerAppUpdateHandlers } = await import(
      "../main/appUpdate"
    );
    registerAppUpdateHandlers();
    updaterMock.emit("update-available", {
      version: "0.1.3",
      releaseDate: null,
      releaseName: null
    });

    const bridgeState = getAppUpdateState();
    expect(bridgeState.status).toBe("error");
    expect(bridgeState.error).toMatch(/metadata failed validation/i);

    const state = await downloadAppUpdate();
    expect(state.status).toBe("error");
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
    expect(updaterMock.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });
});
