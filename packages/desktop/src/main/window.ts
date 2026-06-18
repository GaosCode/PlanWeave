import { BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Event as ElectronEvent, WebContentsConsoleMessageEventParams } from "electron";
import { runSmokeCheck } from "./smoke.js";
import { windowBackgroundColor } from "./windowAppearance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function rendererEntry(): string {
  return join(__dirname, "..", "renderer", "index.html");
}

export async function createWindow(options: { isDev: boolean; isSmoke: boolean }): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    show: !options.isSmoke,
    title: "PlanWeave Desktop",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: windowBackgroundColor("system"),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

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
