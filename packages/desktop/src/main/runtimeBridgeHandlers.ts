import { BrowserWindow, ipcMain } from "electron";
import { subscribeAutoRunEvents } from "@planweave-ai/runtime";
import type { DesktopBridgeMainInvokeMethod } from "../shared/ipcChannels.js";
import { autoRunChangedChannel, desktopBridgeInvokeChannels } from "../shared/ipcChannels.js";
import { runtimeBridgeHandlers } from "./runtimeBridgeHandlerRegistry.js";
import { registerRunnerRecordBridgeHandlers } from "./runnerRecordBridge.js";

let unsubscribeAutoRunBroadcast: (() => void) | null = null;

function registerAutoRunEventBroadcast(): void {
  if (unsubscribeAutoRunBroadcast) {
    return;
  }
  unsubscribeAutoRunBroadcast = subscribeAutoRunEvents((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const { webContents } = window;
      if (!webContents.isDestroyed()) {
        webContents.send(autoRunChangedChannel, event);
      }
    }
  });
}

export function registerRuntimeBridgeHandlers(): void {
  for (const method of Object.keys(runtimeBridgeHandlers) as DesktopBridgeMainInvokeMethod[]) {
    ipcMain.handle(desktopBridgeInvokeChannels[method], runtimeBridgeHandlers[method]);
  }
  registerAutoRunEventBroadcast();
  registerRunnerRecordBridgeHandlers();
}
