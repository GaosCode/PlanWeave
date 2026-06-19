import { BrowserWindow, app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopCanvasReference } from "@planweave-ai/runtime";
import { createNativeTranslator } from "../shared/nativeI18n.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const taskInspectorWindows = new Map<string, BrowserWindow>();

type OpenTaskInspectorWindowInput = {
  taskId: string;
  canvas: DesktopCanvasReference;
  language: string;
};

function rendererEntry(): string {
  return join(__dirname, "..", "renderer", "index.html");
}

function taskWindowKey(input: OpenTaskInspectorWindowInput): string {
  return `${input.canvas.projectRoot}:${input.canvas.canvasId ?? "default"}:${input.taskId}`;
}

function taskWindowQuery(input: OpenTaskInspectorWindowInput): Record<string, string> {
  return {
    canvasId: input.canvas.canvasId ?? "",
    language: input.language,
    projectRoot: input.canvas.projectRoot,
    taskId: input.taskId,
    window: "task-inspector"
  };
}

async function loadTaskWindow(window: BrowserWindow, input: OpenTaskInspectorWindowInput): Promise<void> {
  const devServerUrl = process.env.PLANWEAVE_DESKTOP_DEV_SERVER_URL;
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    for (const [key, value] of Object.entries(taskWindowQuery(input))) {
      url.searchParams.set(key, value);
    }
    await window.loadURL(url.toString());
    return;
  }
  await window.loadFile(rendererEntry(), { query: taskWindowQuery(input) });
}

export async function openTaskInspectorWindow(input: OpenTaskInspectorWindowInput): Promise<void> {
  const key = taskWindowKey(input);
  const existing = taskInspectorWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 760,
    height: 780,
    minWidth: 480,
    minHeight: 520,
    show: false,
    title: createNativeTranslator(input.language, app.getLocale()).taskInspectorTitle,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  taskInspectorWindows.set(key, window);
  window.on("closed", () => taskInspectorWindows.delete(key));
  await loadTaskWindow(window, input);
  window.show();
}
