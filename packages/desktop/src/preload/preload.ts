import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  DesktopAutoRunEvent,
  DesktopBridgeApi,
  DesktopPackageFileChangeEvent,
  DesktopRuntimeStateChangeEvent
} from "@planweave-ai/runtime";
import type { AppUpdateState, PlanWeaveAppUpdateApi } from "../shared/appUpdate.js";
import { appUpdateChangedChannel, appUpdateInvokeChannels } from "../shared/appUpdate.js";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings.js";
import { desktopSettingsInvokeChannels } from "../shared/desktopSettings.js";
import {
  autoRunChangedChannel,
  packageFileChangedChannel,
  runtimeStateChangedChannel
} from "../shared/ipcChannels.js";
import type { McpTunnelStatus, PlanWeaveMcpTunnelApi } from "../shared/mcpTunnel.js";
import { mcpTunnelChangedChannel, mcpTunnelInvokeChannels } from "../shared/mcpTunnel.js";
import {
  windowAppearanceInvokeChannels,
  type PlanWeaveWindowApi
} from "../shared/windowAppearance.js";
import { createDesktopBridgeInvokeApi } from "./bridgeInvocation.js";

const invokeApi = createDesktopBridgeInvokeApi((channel, ...args) =>
  ipcRenderer.invoke(channel, ...args)
);
let lastSmokeRevealPath: string | null = null;

const api: DesktopBridgeApi = {
  ...invokeApi,
  revealPathInFinder: async (path) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      lastSmokeRevealPath = path;
      return;
    }
    await invokeApi.revealPathInFinder(path);
  },
  onPackageFileChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopPackageFileChangeEvent) =>
      callback(payload);
    ipcRenderer.on(packageFileChangedChannel, listener);
    return () => ipcRenderer.off(packageFileChangedChannel, listener);
  },
  onRuntimeStateChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopRuntimeStateChangeEvent) =>
      callback(payload);
    ipcRenderer.on(runtimeStateChangedChannel, listener);
    return () => ipcRenderer.off(runtimeStateChangedChannel, listener);
  },
  onAutoRunChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopAutoRunEvent) => callback(payload);
    ipcRenderer.on(autoRunChangedChannel, listener);
    return () => ipcRenderer.off(autoRunChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweave", api);

const desktopSettingsApi: PlanWeaveDesktopSettingsApi = {
  getDesktopSettings: async () =>
    ipcRenderer.invoke(desktopSettingsInvokeChannels.getDesktopSettings),
  saveDesktopSettings: async (patch) =>
    ipcRenderer.invoke(desktopSettingsInvokeChannels.saveDesktopSettings, patch),
  migrateLegacyDesktopSettings: async (payload) =>
    ipcRenderer.invoke(desktopSettingsInvokeChannels.migrateLegacyDesktopSettings, payload)
};

contextBridge.exposeInMainWorld("planweaveDesktopSettings", desktopSettingsApi);

const windowApi: PlanWeaveWindowApi = {
  getWindowMaterialCapabilities: async () =>
    ipcRenderer.invoke(windowAppearanceInvokeChannels.getWindowMaterialCapabilities),
  setWindowMaterial: async (settings) => {
    await ipcRenderer.invoke(windowAppearanceInvokeChannels.setWindowMaterial, settings);
  }
};

contextBridge.exposeInMainWorld("planweaveWindow", windowApi);

const appUpdateApi: PlanWeaveAppUpdateApi = {
  checkForAppUpdate: async () => ipcRenderer.invoke(appUpdateInvokeChannels.checkForAppUpdate),
  downloadAppUpdate: async () => ipcRenderer.invoke(appUpdateInvokeChannels.downloadAppUpdate),
  getAppUpdateState: async () => ipcRenderer.invoke(appUpdateInvokeChannels.getAppUpdateState),
  installAppUpdate: async () => ipcRenderer.invoke(appUpdateInvokeChannels.installAppUpdate),
  onAppUpdateChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: AppUpdateState) => callback(payload);
    ipcRenderer.on(appUpdateChangedChannel, listener);
    return () => ipcRenderer.off(appUpdateChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveAppUpdate", appUpdateApi);

const mcpTunnelApi: PlanWeaveMcpTunnelApi = {
  getMcpTunnelStatus: async () => ipcRenderer.invoke(mcpTunnelInvokeChannels.getMcpTunnelStatus),
  downloadTunnelClient: async () =>
    ipcRenderer.invoke(mcpTunnelInvokeChannels.downloadTunnelClient),
  setTunnelClientPath: async (path) =>
    ipcRenderer.invoke(mcpTunnelInvokeChannels.setTunnelClientPath, path),
  setTunnelAutoStart: async (enabled) =>
    ipcRenderer.invoke(mcpTunnelInvokeChannels.setTunnelAutoStart, enabled),
  startLocalMcp: async (input) => ipcRenderer.invoke(mcpTunnelInvokeChannels.startLocalMcp, input),
  stopLocalMcp: async () => ipcRenderer.invoke(mcpTunnelInvokeChannels.stopLocalMcp),
  startTunnel: async (input) => ipcRenderer.invoke(mcpTunnelInvokeChannels.startTunnel, input),
  stopTunnel: async () => ipcRenderer.invoke(mcpTunnelInvokeChannels.stopTunnel),
  onMcpTunnelChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: McpTunnelStatus) => callback(payload);
    ipcRenderer.on(mcpTunnelChangedChannel, listener);
    return () => ipcRenderer.off(mcpTunnelChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveMcpTunnel", mcpTunnelApi);

if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
  contextBridge.exposeInMainWorld("planweaveSmoke", {
    clearLastRevealPath: () => {
      lastSmokeRevealPath = null;
    },
    getLastRevealPath: () => lastSmokeRevealPath
  });
}
