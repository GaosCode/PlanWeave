import { BrowserWindow, app, ipcMain } from "electron";
import electronUpdater, { type AppUpdater } from "electron-updater";
import type { AppUpdateInfo, AppUpdateProgress, AppUpdateState } from "../shared/appUpdate.js";
import { appUpdateChangedChannel, appUpdateInvokeChannels } from "../shared/appUpdate.js";

type UpdaterUpdateInfo = {
  version: string;
  releaseDate?: string | null;
  releaseName?: string | null;
};

type UpdaterProgressInfo = {
  bytesPerSecond: number;
  percent: number;
  total: number;
  transferred: number;
};

const { autoUpdater } = electronUpdater as { autoUpdater: AppUpdater };

let latestUpdateInfo: AppUpdateInfo | null = null;
let state: AppUpdateState = createBaseState("idle");

function nowIso(): string {
  return new Date().toISOString();
}

function createBaseState(status: "idle" | "checking" | "not-available"): AppUpdateState {
  return {
    status,
    checkedAt: null,
    currentVersion: app.getVersion(),
    error: null,
    progress: null,
    update: null,
    updatedAt: nowIso()
  };
}

function normalizeUpdateInfo(info: UpdaterUpdateInfo): AppUpdateInfo {
  return {
    version: info.version,
    releaseDate: info.releaseDate ?? null,
    releaseName: info.releaseName ?? null
  };
}

function normalizeProgress(progress: UpdaterProgressInfo): AppUpdateProgress {
  return {
    bytesPerSecond: progress.bytesPerSecond,
    percent: Math.max(0, Math.min(100, progress.percent)),
    total: progress.total,
    transferred: progress.transferred
  };
}

function publish(nextState: AppUpdateState): AppUpdateState {
  state = nextState;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(appUpdateChangedChannel, state);
    }
  }
  return state;
}

function setState(next: Omit<AppUpdateState, "currentVersion" | "updatedAt">): AppUpdateState {
  return publish({
    ...next,
    currentVersion: app.getVersion(),
    updatedAt: nowIso()
  } as AppUpdateState);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsupportedState(): AppUpdateState {
  return setState({
    status: "unsupported",
    checkedAt: state.checkedAt,
    error: "Update checks are only available in packaged PlanWeave Desktop builds.",
    progress: null,
    update: latestUpdateInfo
  });
}

function ensurePackaged(): boolean {
  return app.isPackaged;
}

function configureAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.logger = console;
}

export function getAppUpdateState(): AppUpdateState {
  return state;
}

export async function checkForAppUpdate(): Promise<AppUpdateState> {
  if (!ensurePackaged()) {
    return unsupportedState();
  }
  if (state.status === "checking" || state.status === "downloading" || state.status === "downloaded") {
    return state;
  }
  const checkedAt = nowIso();
  setState({
    status: "checking",
    checkedAt,
    error: null,
    progress: null,
    update: latestUpdateInfo
  });
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.updateInfo) {
      latestUpdateInfo = normalizeUpdateInfo(result.updateInfo);
    }
    return state;
  } catch (error) {
    return setState({
      status: "error",
      checkedAt,
      error: errorMessage(error),
      progress: null,
      update: latestUpdateInfo
    });
  }
}

export async function downloadAppUpdate(): Promise<AppUpdateState> {
  if (!ensurePackaged()) {
    return unsupportedState();
  }
  if (state.status === "downloading" || state.status === "downloaded") {
    return state;
  }
  if (!latestUpdateInfo || state.status !== "available") {
    return setState({
      status: "error",
      checkedAt: state.checkedAt,
      error: "No available update has been found yet.",
      progress: null,
      update: latestUpdateInfo
    });
  }
  setState({
    status: "downloading",
    checkedAt: state.checkedAt,
    error: null,
    progress: {
      bytesPerSecond: 0,
      percent: 0,
      total: 0,
      transferred: 0
    },
    update: latestUpdateInfo
  });
  try {
    await autoUpdater.downloadUpdate();
    return state;
  } catch (error) {
    return setState({
      status: "error",
      checkedAt: state.checkedAt,
      error: errorMessage(error),
      progress: null,
      update: latestUpdateInfo
    });
  }
}

export async function installAppUpdate(): Promise<AppUpdateState> {
  if (!ensurePackaged()) {
    return unsupportedState();
  }
  if (state.status !== "downloaded") {
    return setState({
      status: "error",
      checkedAt: state.checkedAt,
      error: "No downloaded update is ready to install.",
      progress: null,
      update: latestUpdateInfo
    });
  }
  try {
    autoUpdater.quitAndInstall(false, true);
    return state;
  } catch (error) {
    return setState({
      status: "error",
      checkedAt: state.checkedAt,
      error: errorMessage(error),
      progress: null,
      update: latestUpdateInfo
    });
  }
}

export function registerAppUpdateHandlers(): void {
  configureAutoUpdater();

  autoUpdater.on("checking-for-update", () => {
    setState({
      status: "checking",
      checkedAt: nowIso(),
      error: null,
      progress: null,
      update: latestUpdateInfo
    });
  });
  autoUpdater.on("update-available", (info: UpdaterUpdateInfo) => {
    latestUpdateInfo = normalizeUpdateInfo(info);
    setState({
      status: "available",
      checkedAt: state.checkedAt,
      error: null,
      progress: null,
      update: latestUpdateInfo
    });
  });
  autoUpdater.on("update-not-available", (info: UpdaterUpdateInfo) => {
    latestUpdateInfo = normalizeUpdateInfo(info);
    setState({
      status: "not-available",
      checkedAt: state.checkedAt,
      error: null,
      progress: null,
      update: latestUpdateInfo
    });
  });
  autoUpdater.on("download-progress", (progress: UpdaterProgressInfo) => {
    if (!latestUpdateInfo) {
      return;
    }
    setState({
      status: "downloading",
      checkedAt: state.checkedAt,
      error: null,
      progress: normalizeProgress(progress),
      update: latestUpdateInfo
    });
  });
  autoUpdater.on("update-downloaded", (info: UpdaterUpdateInfo) => {
    latestUpdateInfo = normalizeUpdateInfo(info);
    setState({
      status: "downloaded",
      checkedAt: state.checkedAt,
      error: null,
      progress: null,
      update: latestUpdateInfo
    });
  });
  autoUpdater.on("error", (error) => {
    setState({
      status: "error",
      checkedAt: state.checkedAt,
      error: errorMessage(error),
      progress: null,
      update: latestUpdateInfo
    });
  });

  ipcMain.handle(appUpdateInvokeChannels.getAppUpdateState, getAppUpdateState);
  ipcMain.handle(appUpdateInvokeChannels.checkForAppUpdate, checkForAppUpdate);
  ipcMain.handle(appUpdateInvokeChannels.downloadAppUpdate, downloadAppUpdate);
  ipcMain.handle(appUpdateInvokeChannels.installAppUpdate, installAppUpdate);
}
