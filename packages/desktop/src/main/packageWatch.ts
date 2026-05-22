import { ipcMain } from "electron";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, relative } from "node:path";
import { resolveTaskCanvasWorkspace } from "@planweave/runtime";
import type { DesktopPackageFileChangeEvent } from "@planweave/runtime";
import type { WebContents } from "electron";

const packageFileChangedChannel = "planweave:packageFileChanged";

type PackageWatch = {
  watchers: FSWatcher[];
  subscribers: Map<number, WebContents>;
  changedPaths: Set<string>;
  timer: NodeJS.Timeout | null;
};

const packageWatches = new Map<string, PackageWatch>();

function watchKey(projectRoot: string, canvasId?: string | null): string {
  return `${projectRoot}::${canvasId ?? "default"}`;
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function shouldNotifyPackagePath(path: string): boolean {
  return path === "package/manifest.json" || path === "policy/project-prompt.md" || /^package\/nodes\/.+\.md$/.test(path);
}

function watchRoot(projectRoot: string, rootPath: string, recordChange: (path: string) => void): FSWatcher | null {
  if (!existsSync(rootPath)) {
    return null;
  }
  const onChange = (_eventType: string, filename: string | Buffer | null) => {
    if (!filename) {
      recordChange(toPosixPath(relative(projectRoot, rootPath)));
      return;
    }
    recordChange(toPosixPath(relative(projectRoot, join(rootPath, filename.toString()))));
  };
  try {
    return watch(rootPath, { recursive: true }, onChange);
  } catch {
    return watch(rootPath, onChange);
  }
}

function flushPackageFileChange(projectRoot: string, canvasId?: string | null): void {
  const activeWatch = packageWatches.get(watchKey(projectRoot, canvasId));
  if (!activeWatch) {
    return;
  }
  activeWatch.timer = null;
  const paths = [...activeWatch.changedPaths].filter(shouldNotifyPackagePath);
  activeWatch.changedPaths.clear();
  if (paths.length === 0) {
    return;
  }
  const payload: DesktopPackageFileChangeEvent = {
    projectRoot,
    canvasId: canvasId ?? null,
    paths,
    triggeredAt: new Date().toISOString()
  };
  for (const webContents of activeWatch.subscribers.values()) {
    if (!webContents.isDestroyed()) {
      webContents.send(packageFileChangedChannel, payload);
    }
  }
}

async function startPackageWatch(projectRoot: string, canvasId: string | null | undefined, webContents: WebContents): Promise<void> {
  const key = watchKey(projectRoot, canvasId);
  let activeWatch = packageWatches.get(key);
  if (!activeWatch) {
    const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
    const recordChange = (path: string) => {
      const currentWatch = packageWatches.get(key);
      if (!currentWatch) {
        return;
      }
      currentWatch.changedPaths.add(path);
      if (currentWatch.timer) {
        clearTimeout(currentWatch.timer);
      }
      currentWatch.timer = setTimeout(() => flushPackageFileChange(projectRoot, canvasId), 150);
    };
    const watchers = [
      watchRoot(workspace.workspaceRoot, workspace.packageDir, recordChange),
      watchRoot(workspace.workspaceRoot, dirname(workspace.projectPromptFile), recordChange),
      watchRoot(workspace.workspaceRoot, join(workspace.packageDir, "nodes"), recordChange)
    ].filter((item): item is FSWatcher => item !== null);
    if (watchers.length === 0) {
      throw new Error(`No package file watch roots exist under '${workspace.workspaceRoot}'.`);
    }
    activeWatch = {
      watchers,
      subscribers: new Map(),
      changedPaths: new Set(),
      timer: null
    };
    packageWatches.set(key, activeWatch);
  }
  activeWatch.subscribers.set(webContents.id, webContents);
  webContents.once("destroyed", () => stopPackageWatch(projectRoot, canvasId, webContents));
}

function stopPackageWatch(projectRoot: string, canvasId: string | null | undefined, webContents: WebContents): void {
  const key = watchKey(projectRoot, canvasId);
  const activeWatch = packageWatches.get(key);
  if (!activeWatch) {
    return;
  }
  activeWatch.subscribers.delete(webContents.id);
  if (activeWatch.subscribers.size > 0) {
    return;
  }
  for (const watcher of activeWatch.watchers) {
    watcher.close();
  }
  if (activeWatch.timer) {
    clearTimeout(activeWatch.timer);
  }
  packageWatches.delete(key);
}

export function registerPackageWatchHandlers(): void {
  ipcMain.handle("planweave:watchPackageFiles", (event, projectRoot: string, canvasId?: string | null) => startPackageWatch(projectRoot, canvasId, event.sender));
  ipcMain.handle("planweave:unwatchPackageFiles", (event, projectRoot: string, canvasId?: string | null) => stopPackageWatch(projectRoot, canvasId, event.sender));
}
