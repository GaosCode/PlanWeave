import { BrowserWindow, shell } from "electron";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Event as ElectronEvent, WebContentsConsoleMessageEventParams } from "electron";
import { runSmokeCheck } from "./smoke.js";
import {
  isRendererUncaughtConsoleMessage,
  rendererUncaughtSmokeEvent
} from "./smokeFailureGate.js";
import { applyLiquidGlassToWindow, windowBackgroundColor } from "./windowAppearance.js";
import { windowChromeOptions } from "./windowChrome.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const allowedExternalUrls = new Set([
  "https://github.com/openai/tunnel-client/releases/latest",
  "https://github.com/GaosCode/PlanWeave/releases/latest"
]);

function rendererDir(): string {
  return resolve(__dirname, "..", "renderer");
}

function rendererEntry(): string {
  return join(rendererDir(), "index.html");
}

export function isAllowedNavigation(url: string, options: { isDev: boolean }): boolean {
  if (options.isDev) {
    const devServerUrl = process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL;
    if (!devServerUrl) {
      return false;
    }
    try {
      return new URL(url).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }

  try {
    const target = new URL(url);
    if (target.protocol !== "file:") {
      return false;
    }
    const filePath = resolve(fileURLToPath(target));
    const allowedRoot = rendererDir();
    return filePath === allowedRoot || filePath.startsWith(`${allowedRoot}${sep}`);
  } catch {
    return false;
  }
}

export function configureExternalLinkHandling(window: Pick<BrowserWindow, "webContents">): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedExternalUrls.has(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

export function configureNavigationHandling(
  window: Pick<BrowserWindow, "webContents">,
  options: { isDev: boolean }
): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, options)) {
      event.preventDefault();
    }
  });
}

export async function createWindow(options: {
  isDev: boolean;
  isSmoke: boolean;
  isStartupSmoke?: boolean;
}): Promise<BrowserWindow> {
  // macOS liquid glass requires a transparent window so the NSGlassEffectView
  // behind the web contents can blend with whatever sits behind the window.
  const isMac = process.platform === "darwin";
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    show: !options.isSmoke && !options.isStartupSmoke,
    title: "PlanWeave Desktop",
    ...windowChromeOptions(process.platform),
    transparent: isMac,
    backgroundColor: isMac ? "#00000000" : windowBackgroundColor("system"),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (isMac) {
    // Transparent windows can hide the traffic-light controls; force them back.
    window.setWindowButtonVisibility?.(true);
  }

  configureExternalLinkHandling(window);
  configureNavigationHandling(window, { isDev: options.isDev });

  await applyLiquidGlassToWindow(window);

  if (options.isSmoke) {
    window.webContents.on(
      "console-message",
      (details: ElectronEvent<WebContentsConsoleMessageEventParams>) => {
        console.log(
          JSON.stringify({
            event: "PLANWEAVE_DESKTOP_RENDERER_CONSOLE",
            level: details.level,
            message: details.message,
            sourceId: details.sourceId,
            lineNumber: details.lineNumber
          })
        );
        if (isRendererUncaughtConsoleMessage(details)) {
          console.error(
            JSON.stringify({
              event: rendererUncaughtSmokeEvent,
              message: details.message,
              sourceId: details.sourceId,
              lineNumber: details.lineNumber
            })
          );
        }
      }
    );
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      console.error(
        JSON.stringify({ event: "PLANWEAVE_DESKTOP_LOAD_FAILED", errorCode, errorDescription })
      );
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      console.error(JSON.stringify({ event: "PLANWEAVE_DESKTOP_RENDERER_GONE", details }));
    });
  }

  if (options.isDev) {
    await window.loadURL(process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL as string);
  } else {
    await window.loadFile(rendererEntry());
  }
  if (options.isSmoke) {
    await runSmokeCheck(window);
  }
  return window;
}
