import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { windowAppearanceInvokeChannels, type WindowMaterialCapabilities, type WindowMaterialSettings } from "../shared/windowAppearance.js";

const lightWindowBackground = "#f7f8fa";
const darkWindowBackground = "#1f211f";
const materialWindowBackground = "#00000000";

function shouldUseDarkWindowBackground(appearance: WindowMaterialSettings["appearance"]): boolean {
  if (appearance === "dark") {
    return true;
  }
  if (appearance === "light") {
    return false;
  }
  return nativeTheme.shouldUseDarkColors;
}

export function getWindowMaterialCapabilities(): WindowMaterialCapabilities {
  if (process.platform === "darwin") {
    return typeof BrowserWindow.prototype.setVibrancy === "function"
      ? { platform: process.platform, reason: "supported", supported: true }
      : { platform: process.platform, reason: "missing-electron-api", supported: false };
  }
  if (process.platform === "win32") {
    return typeof BrowserWindow.prototype.setBackgroundMaterial === "function"
      ? { platform: process.platform, reason: "supported", supported: true }
      : { platform: process.platform, reason: "missing-electron-api", supported: false };
  }
  return { platform: process.platform, reason: "unsupported-platform", supported: false };
}

export function windowBackgroundColor(appearance: WindowMaterialSettings["appearance"], materialEnabled = false): string {
  if (materialEnabled && getWindowMaterialCapabilities().supported) {
    return materialWindowBackground;
  }
  return shouldUseDarkWindowBackground(appearance) ? darkWindowBackground : lightWindowBackground;
}

export function applyWindowMaterial(window: BrowserWindow, settings: WindowMaterialSettings): void {
  const materialEnabled = settings.enabled && getWindowMaterialCapabilities().supported;
  window.setBackgroundColor(windowBackgroundColor(settings.appearance, materialEnabled));
  if (process.platform === "darwin") {
    window.setVibrancy(materialEnabled ? "under-window" : null);
    return;
  }
  if (process.platform === "win32") {
    window.setBackgroundMaterial(materialEnabled ? "mica" : "none");
  }
}

function setWindowMaterial(event: IpcMainInvokeEvent, settings: WindowMaterialSettings): void {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) {
    throw new Error("No BrowserWindow owns the window material request.");
  }
  applyWindowMaterial(owner, settings);
}

export function registerWindowAppearanceHandlers(): void {
  ipcMain.handle(windowAppearanceInvokeChannels.getWindowMaterialCapabilities, getWindowMaterialCapabilities);
  ipcMain.handle(windowAppearanceInvokeChannels.setWindowMaterial, setWindowMaterial);
}
