import { BrowserWindow, app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopCanvasReference } from "@planweave-ai/runtime";
import { createNativeTranslator } from "../shared/nativeI18n.js";
import { configureExternalLinkHandling, configureNavigationHandling } from "./window.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const blockInspectorWindows = new Map<string, BrowserWindow>();

type OpenBlockInspectorWindowInput = {
  blockRef: string;
  canvas: DesktopCanvasReference;
  language: string;
};

function rendererEntry(): string {
  return join(__dirname, "..", "renderer", "index.html");
}

function blockWindowKey(input: OpenBlockInspectorWindowInput): string {
  return `${input.canvas.projectRoot}:${input.canvas.canvasId ?? "default"}:${input.blockRef}`;
}

function blockWindowQuery(input: OpenBlockInspectorWindowInput): Record<string, string> {
  return {
    blockRef: input.blockRef,
    canvasId: input.canvas.canvasId ?? "",
    language: input.language,
    projectRoot: input.canvas.projectRoot,
    window: "block-inspector"
  };
}

async function loadBlockWindow(
  window: BrowserWindow,
  input: OpenBlockInspectorWindowInput,
  devServerUrl: string | undefined
): Promise<void> {
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    for (const [key, value] of Object.entries(blockWindowQuery(input))) {
      url.searchParams.set(key, value);
    }
    await window.loadURL(url.toString());
    return;
  }
  await window.loadFile(rendererEntry(), { query: blockWindowQuery(input) });
}

export async function openBlockInspectorWindow(
  input: OpenBlockInspectorWindowInput
): Promise<void> {
  const key = blockWindowKey(input);
  const existing = blockInspectorWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const devServerUrl = process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL;
  const window = new BrowserWindow({
    width: 760,
    height: 780,
    minWidth: 480,
    minHeight: 520,
    show: false,
    title: createNativeTranslator(input.language, app.getLocale()).blockInspectorTitle,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  configureExternalLinkHandling(window);
  configureNavigationHandling(window, {
    isDev: Boolean(devServerUrl)
  });

  blockInspectorWindows.set(key, window);
  window.on("closed", () => blockInspectorWindows.delete(key));
  await loadBlockWindow(window, input, devServerUrl);
  window.show();
}
