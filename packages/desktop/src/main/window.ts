import { BrowserWindow, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Event as ElectronEvent, WebContentsConsoleMessageEventParams } from "electron";
import { runSmokeCheck } from "./smoke.js";
import { applyLiquidGlassToWindow, windowBackgroundColor } from "./windowAppearance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const allowedExternalUrls = new Set(["https://github.com/openai/tunnel-client/releases/latest"]);

function rendererEntry(): string {
  return join(__dirname, "..", "renderer", "index.html");
}

export function configureExternalLinkHandling(window: Pick<BrowserWindow, "webContents">): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedExternalUrls.has(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

export async function createWindow(options: { isDev: boolean; isSmoke: boolean }): Promise<BrowserWindow> {
  // macOS liquid glass requires a transparent window so the NSGlassEffectView
  // behind the web contents can blend with whatever sits behind the window.
  const isMac = process.platform === "darwin";
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    show: !options.isSmoke,
    title: "PlanWeave Desktop",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    transparent: isMac,
    backgroundColor: isMac ? "#00000000" : windowBackgroundColor("system"),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isMac) {
    // Transparent windows can hide the traffic-light controls; force them back.
    window.setWindowButtonVisibility?.(true);
  }

  configureExternalLinkHandling(window);

  await applyLiquidGlassToWindow(window);

  if (options.isSmoke) {
    window.webContents.on("console-message", (details: ElectronEvent<WebContentsConsoleMessageEventParams>) => {
      console.log(JSON.stringify({ event: "PLANWEAVE_DESKTOP_RENDERER_CONSOLE", message: details.message }));
    });
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      console.error(JSON.stringify({ event: "PLANWEAVE_DESKTOP_LOAD_FAILED", errorCode, errorDescription }));
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
