import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  DesktopAutoRunEvent,
  DesktopBridgeApi,
  DesktopPackageFileChangeEvent
} from "@planweave-ai/runtime";
import { autoRunChangedChannel, packageFileChangedChannel } from "../shared/ipcChannels.js";
import { createDesktopBridgeInvokeApi } from "./bridgeInvocation.js";

const api: DesktopBridgeApi = {
  ...createDesktopBridgeInvokeApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  onPackageFileChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopPackageFileChangeEvent) => callback(payload);
    ipcRenderer.on(packageFileChangedChannel, listener);
    return () => ipcRenderer.off(packageFileChangedChannel, listener);
  },
  onAutoRunChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopAutoRunEvent) => callback(payload);
    ipcRenderer.on(autoRunChangedChannel, listener);
    return () => ipcRenderer.off(autoRunChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweave", api);
