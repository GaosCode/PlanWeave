import { existsSync, watch, type FSWatcher } from "node:fs";
import type { PackageWatchBackendHandle } from "./packageWatchBackend.js";
import {
  normalizeWatchEventPath,
  type TaskCanvasWorkspace,
  watchedRootsForWorkspace
} from "./packageWatchPaths.js";

function watchRoot(
  rootPath: string,
  relativeRoot: string,
  coarsePath: string,
  recordChange: (path: string) => void,
  onError?: (error: unknown) => void
): FSWatcher | null {
  if (!existsSync(rootPath)) {
    return null;
  }
  const onChange = (_eventType: string, filename: string | Buffer | null) => {
    recordChange(normalizeWatchEventPath(relativeRoot, coarsePath, filename));
  };
  const watcher = watch(rootPath, { recursive: true }, onChange);
  if (onError) {
    watcher.on("error", (err) => {
      onError(err);
    });
  }
  return watcher;
}

export function startNativePackageWatchBackend(
  workspace: TaskCanvasWorkspace,
  recordChange: (path: string) => void,
  onError?: (error: unknown) => void
): PackageWatchBackendHandle | null {
  const watchers: FSWatcher[] = [];
  const roots = watchedRootsForWorkspace(workspace);
  try {
    for (const root of roots) {
      const watcher = watchRoot(
        root.rootPath,
        root.relativeRoot,
        root.coarsePath,
        recordChange,
        onError
      );
      if (watcher) {
        watchers.push(watcher);
      }
    }
  } catch {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
    return null;
  }
  if (watchers.length === 0) {
    return null;
  }
  let closed = false;
  return {
    kind: "native",
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const watcher of watchers) {
        try {
          watcher.removeAllListeners?.("error");
          watcher.close();
        } catch {
          /* ignore */
        }
      }
      watchers.length = 0;
    }
  };
}
