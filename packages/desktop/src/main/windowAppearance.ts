import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import {
  windowAppearanceInvokeChannels,
  type WindowMaterialCapabilities,
  type WindowMaterialSettings
} from "../shared/windowAppearance.js";

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

export function windowBackgroundColor(
  appearance: WindowMaterialSettings["appearance"],
  materialEnabled = false
): string {
  if (materialEnabled && getWindowMaterialCapabilities().supported) {
    return materialWindowBackground;
  }
  return shouldUseDarkWindowBackground(appearance) ? darkWindowBackground : lightWindowBackground;
}

let liquidGlassActive = false;

// Apply the macOS 26 (Tahoe) NSGlassEffectView so the real liquid-glass
// material backs translucent shell surfaces. The addon falls back to legacy
// vibrancy internally on older systems. Imported lazily so unit tests (which
// mock electron but not this native addon) never load the binary.
export async function applyLiquidGlassToWindow(window: BrowserWindow): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    const { default: liquidGlass } = await import("electron-liquid-glass");
    const viewId = liquidGlass.addView(window.getNativeWindowHandle(), { cornerRadius: 12 });
    if (viewId >= 0) {
      liquidGlassActive = true;
      window.setBackgroundColor(materialWindowBackground);
    }
  } catch (error) {
    console.error(
      "Failed to apply liquid glass:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function applyWindowMaterial(window: BrowserWindow, settings: WindowMaterialSettings): void {
  if (process.platform === "darwin" && liquidGlassActive) {
    // Native liquid glass owns the macOS window background. The renderer's
    // `data-window-material` flag decides whether shell surfaces reveal it,
    // so there is no native vibrancy to toggle here.
    window.setBackgroundColor(materialWindowBackground);
    return;
  }
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
  ipcMain.handle(
    windowAppearanceInvokeChannels.getWindowMaterialCapabilities,
    getWindowMaterialCapabilities
  );
  ipcMain.handle(windowAppearanceInvokeChannels.setWindowMaterial, setWindowMaterial);
}
