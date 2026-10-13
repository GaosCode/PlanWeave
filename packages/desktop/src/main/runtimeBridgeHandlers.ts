import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { resolvePlanweaveHome, subscribeAutoRunEvents } from "@planweave-ai/runtime";
import type { DesktopBridgeMainInvokeMethod } from "../shared/ipcChannels.js";
import { autoRunChangedChannel, desktopBridgeInvokeChannels } from "../shared/ipcChannels.js";
import { runtimeBridgeHandlers } from "./runtimeBridgeHandlerRegistry.js";
import { registerRunnerRecordBridgeHandlers } from "./runnerRecordBridge.js";
import {
  assertDesktopInspectorHomeCurrent,
  isDesktopInspectorHomeCurrent
} from "./desktopInspectorHome.js";
import type { RuntimeBridgeHandler, RuntimeBridgeHandlerMap } from "./runtimeBridgeHandlerTypes.js";

function registerRuntimeHandler<M extends DesktopBridgeMainInvokeMethod>(method: M): void {
  const handlers: RuntimeBridgeHandlerMap = runtimeBridgeHandlers;
  const handler = handlers[method];
  const admitted: RuntimeBridgeHandler<M> = (event: IpcMainInvokeEvent, ...args) => {
    assertDesktopInspectorHomeCurrent(event.sender);
    return handler(event, ...args);
  };
  ipcMain.handle(desktopBridgeInvokeChannels[method], admitted);
}

let unsubscribeAutoRunBroadcast: (() => void) | null = null;

function registerAutoRunEventBroadcast(): void {
  if (unsubscribeAutoRunBroadcast) {
    return;
  }
  unsubscribeAutoRunBroadcast = subscribeAutoRunEvents((event) => {
    if (event.planweaveHome !== resolvePlanweaveHome()) return;
    for (const window of BrowserWindow.getAllWindows()) {
      const { webContents } = window;
      if (!webContents.isDestroyed() && isDesktopInspectorHomeCurrent(webContents)) {
        webContents.send(autoRunChangedChannel, event);
      }
    }
  });
}

export function registerRuntimeBridgeHandlers(): void {
  for (const method of Object.keys(runtimeBridgeHandlers) as DesktopBridgeMainInvokeMethod[]) {
    registerRuntimeHandler(method);
  }
  registerAutoRunEventBroadcast();
  registerRunnerRecordBridgeHandlers();
}
