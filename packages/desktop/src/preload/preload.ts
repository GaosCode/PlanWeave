import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  DesktopBridgeApi,
  DesktopPackageFileChangeEvent
} from "@planweave-ai/runtime";
import { packageFileChangedChannel } from "../shared/ipcChannels.js";
import { createDesktopBridgeInvokeApi } from "./bridgeInvocation.js";

const api: DesktopBridgeApi = {
  ...createDesktopBridgeInvokeApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  onPackageFileChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopPackageFileChangeEvent) => callback(payload);
    ipcRenderer.on(packageFileChangedChannel, listener);
    return () => ipcRenderer.off(packageFileChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweave", api);
